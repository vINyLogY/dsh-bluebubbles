// src/lib.ts — shared helpers for the dsh-bluebubbles plugin family (erasable
// TS syntax only). Relative imports must carry the .ts extension because Node
// native type stripping does no path rewriting.

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import type { Workspace } from '@deepseek-ai/dsh-workspace'
import type { ShellExecRequest, ShellExecSpec, ShellRunResult } from '@deepseek-ai/dsh-shell'

// ================= service access =================
// These interfaces are structural views over host services; getService keeps
// every consumer on the optional ctx.get() path so a missing service degrades
// instead of blocking plugin activation.
export function getService<T>(ctx: Context, name: string): T | undefined {
  const raw = (ctx as unknown as { get(name: string): unknown }).get(name)
  return raw as T | undefined
}

export interface AgentsService {
  get(id: string): Agent | undefined
  list(): Agent[]
  roots(): Agent[]
  isOwnedBy(id: string, owner: Agent): boolean
  resume(options: { resumeSessionId: string; setup?: (agentCtx: unknown) => Promise<void> }): Promise<{ agent: Agent }>
}
export interface SessionPersistenceService {
  list(): Promise<Array<{ id: string }>>
  inspect(id: string): Promise<{
    meta: { id: string; origin?: string; agentPreset?: string }
    events: Array<{ type?: string; data?: { agentPreset?: string } }>
  }>
}
export interface AgentPresetsService {
  resolve(id?: string): Promise<{ id: string }>
  mount(agentCtx: unknown, id: string): Promise<unknown>
}
export interface WorkspaceRegistryService {
  resolveByPath(path: string): Promise<Workspace | undefined>
}
export interface FsTarget {}
export interface FsService {
  resolve(path: string): Promise<FsTarget>
  readText(target: FsTarget): Promise<string>
  writeText(target: FsTarget, content: string): Promise<unknown>
}
export interface TimerService {
  interval(callback: () => void, delay: number): () => void
  timeout(callback: () => void, delay: number): () => void
}
export interface ShellService {
  resolve(request: ShellExecRequest): ShellExecSpec
  run(spec: ShellExecSpec): Promise<ShellRunResult>
}

/** A target session reference: either a workspace path or an exact session id. */
export interface SessionTarget {
  workspacePath?: string
  sessionId?: string
}

// ================= dotenv parsing =================
export function pickEnvValue(text: string, name: string): string | null {
  const re = new RegExp('(?:^|\\n)\\s*(?:export\\s+)?' + name + '=(?:"([^"]*)"|\'([^\']*)\'|([^\\s"\']+))', 'm')
  const m = re.exec(text)
  if (!m) return null
  return (m[1] || m[2] || m[3] || '').trim()
}

/** Parse "30m"/"2h"/"12h"/"90s"/"5000ms" into milliseconds; a bare number means hours. */
export function parseInterval(raw: string | undefined): number | null {
  if (raw === undefined || raw.trim() === '') return null
  const m = /^\s*(\d+(?:\.\d+)?)\s*(ms|s|m|h)?\s*$/i.exec(raw)
  if (!m) return null
  const n = Number(m[1])
  if (!Number.isFinite(n) || n <= 0) return null
  const unit = (m[2] || 'h').toLowerCase()
  return unit === 'ms' ? n : unit === 's' ? n * 1000 : unit === 'm' ? n * 60 * 1000 : n * 3600 * 1000
}

// ================= env file fallback chain =================
/**
 * Read each file in order and return the first non-empty text. DSH injects
 * .env only at process start; on hot reload nothing re-injects it, so plugins
 * re-read the files themselves to avoid silently losing credentials.
 */
export async function readEnvFiles(shell: ShellService, files: readonly string[]): Promise<string | null> {
  for (const file of files) {
    try {
      const spec: ShellExecSpec = shell.resolve({ command: 'cat ' + file + ' 2>/dev/null', timeoutMs: 8000, stdoutMaxBytes: 32768 } satisfies ShellExecRequest)
      const run: ShellRunResult = await shell.run(spec)
      if (run.exitCode === 0 && run.stdout && run.stdout.text) return run.stdout.text
    } catch {
      // try the next file
    }
  }
  return null
}

// ================= session resolution =================
/**
 * sessionId wins over workspacePath: bindings written for one conversation
 * must not drift when a newer session appears in the same workspace.
 * workspacePath resolves to sessionIds[0], the workspace registry's most
 * recent session.
 */
export async function resolveSession(
  workspaces: WorkspaceRegistryService | undefined,
  target: SessionTarget,
): Promise<string | null> {
  if (target && target.sessionId) return target.sessionId
  if (!target || !target.workspacePath || !workspaces) return null
  try {
    const ws = await workspaces.resolveByPath(target.workspacePath)
    if (ws && Array.isArray(ws.sessionIds) && ws.sessionIds.length > 0) return ws.sessionIds[0] as string
  } catch (err) {
    console.log('lib: workspace resolution failed: ' + (err instanceof Error ? err.message : err))
  }
  return null
}

// ================= agent resume =================
// Inbound iMessage/cron delivery used to require the target session's agent
// to be live already, so a DSH restart silently broke every bound chat until
// someone reopened it in the web UI. ensureLiveAgent reproduces the web
// attach path: fold the stored preset from the session log (last
// agent-preset/selected event wins over the creation header), then resume the
// persisted session under this plugin's ownership. The returned handle is
// deliberately dropped — ownership follows the plugin fiber, so the agent
// stays live until plugin teardown, and a hot reload simply re-resumes on the
// next inbound message.
const resumeInflight = new Map<string, Promise<Agent | undefined>>()

export function ensureLiveAgent(ctx: Context, agents: AgentsService | undefined, sessionId: string): Promise<Agent | undefined> {
  const live = agents ? agents.get(sessionId) : undefined
  if (live) return Promise.resolve(live)
  const pending = resumeInflight.get(sessionId)
  if (pending) return pending // an inbound burst must not race two resumes of one session
  const attempt = (async (): Promise<Agent | undefined> => {
    try {
      if (!agents || typeof agents.resume !== 'function') return undefined
      const persistence = getService<SessionPersistenceService>(ctx, 'sessionPersistence')
      const presets = getService<AgentPresetsService>(ctx, 'agentPresets')
      if (!persistence || !presets) return undefined
      const stored = (await persistence.list()).find((header) => header.id === sessionId)
      if (!stored) return undefined
      const inspected = await persistence.inspect(sessionId)
      // a subagent session is owned by its parent; resuming it standalone would split ownership
      if (inspected.meta && inspected.meta.origin === 'subagent') return undefined
      let presetId = inspected.meta.agentPreset
      for (let index = inspected.events.length - 1; index >= 0; index -= 1) {
        const event = inspected.events[index]
        if (event && event.type === 'agent-preset/selected' && event.data) {
          presetId = event.data.agentPreset
          break
        }
      }
      const resolved = await presets.resolve(presetId)
      const handle = await agents.resume({
        resumeSessionId: sessionId,
        setup: async (agentCtx: unknown) => {
          await presets.mount(agentCtx, resolved.id)
        },
      })
      console.log('bb: resumed persisted session ' + sessionId + ' (preset ' + resolved.id + ')')
      return handle.agent
    } catch (err) {
      console.log('bb: session resume failed for ' + sessionId + ': ' + (err instanceof Error ? err.message : err))
      return undefined
    } finally {
      resumeInflight.delete(sessionId)
    }
  })()
  resumeInflight.set(sessionId, attempt)
  return attempt
}

// ================= message injection =================
/**
 * Inject a text as a user message into the target session and wake it.
 * @returns whether delivery happened; a missing live agent yields false
 *          instead of throwing so callers decide between drop and retry.
 */
export function sendUserMessage(
  agents: AgentsService | undefined,
  sessionId: string,
  text: string,
  sourcePlugin: string,
  target: 'next-turn' | 'next-step' = 'next-turn',
): boolean {
  const agent = agents ? agents.get(sessionId) : undefined
  if (!agent) return false
  const message = {
    id: sourcePlugin + '-' + Date.now().toString(36) + '-' + Math.floor(Math.random() * 1e9).toString(36),
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'plugin', plugin: sourcePlugin },
  } as unknown as UserMessage
  agent.send(message, target, true)
  return true
}
