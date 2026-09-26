// src/lib.ts — shared helpers for the dsh-bluebubbles plugin family (erasable
// TS syntax only). Relative imports must carry the .ts extension because Node
// native type stripping does no path rewriting.

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { UserMessage, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
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
  resume(options: {
    resumeSessionId: string
    /** Per-agent options (model, …); the entry point owns this selection. */
    agentOptions?: { provider?: string; model?: string; reasoningEffort?: string; maxTokens?: number }
    setup?: (agentCtx: unknown) => Promise<void>
  }): Promise<{ agent: Agent }>
}
interface StoredSession {
  meta: { id: string; origin?: string; agentPreset?: string }
  events: ReadonlyArray<{
    type?: string
    data?: {
      agentPreset?: string
      header?: {
        config?: { provider?: string; model?: string; reasoningEffort?: string; maxTokens?: number }
        adapterDefaults?: { reasoningEffort?: true }
      }
    }
  }>
}
export interface SessionPersistenceService {
  list(): Promise<ReadonlyArray<{ id?: string; header?: { id: string } }>>
  /** DSH 0.1.1 inspection API. */
  inspect?(id: string): Promise<StoredSession>
  /** DSH 0.1.7 handle API; read observation never owns the live writer. */
  open?(id: string, access: 'read'): Promise<{
    header: StoredSession['meta']
    read(): Promise<{ events: StoredSession['events'] }>
    close(): Promise<void>
  }>
}
/** Deployment default model selection (settings-backed). */
export interface AgentDefaultModelService {
  currentSelection(): { provider?: string; model?: string; reasoningEffort?: string } | undefined
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
  run?(spec: ShellExecSpec): Promise<ShellRunResult>
  execute?(spec: ShellExecSpec): Promise<{ result(): Promise<ShellRunResult> }>
}

/** Foreground shell projection across the verified DSH API generations. */
export async function runShell(shell: ShellService, spec: ShellExecSpec): Promise<ShellRunResult> {
  if (typeof shell.run === 'function') return shell.run(spec)
  if (typeof shell.execute === 'function') return (await shell.execute(spec)).result()
  throw new Error('bb: shell service has neither run nor execute')
}

async function inspectSession(persistence: SessionPersistenceService, sessionId: string): Promise<StoredSession | undefined> {
  if (typeof persistence.inspect === 'function') return persistence.inspect(sessionId)
  if (typeof persistence.open !== 'function') return undefined
  const handle = await persistence.open(sessionId, 'read')
  try {
    return { meta: handle.header, events: (await handle.read()).events }
  } finally {
    await handle.close()
  }
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
      const run: ShellRunResult = await runShell(shell, spec)
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
      const stored = (await persistence.list()).find((entry) => (entry.header?.id ?? entry.id) === sessionId)
      if (!stored) return undefined
      const inspected = await inspectSession(persistence, sessionId)
      if (!inspected) return undefined
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
      // A resumed agent needs a model. This plugin IS the entry point for a
      // chat-driven session, so the web attach path's session-local selection
      // never runs: without this the resumed agent answers every turn with
      // "has no provider/model". Prefer the session's own last request
      // selection so the established request prefix (and KV cache) survives,
      // then fall back to the deployment default from settings.
      let provider: string | undefined
      let model: string | undefined
      let maxTokens: number | undefined
      let reasoningEffort: string | undefined
      for (let index = inspected.events.length - 1; index >= 0; index -= 1) {
        const event = inspected.events[index]
        const config = event?.type === 'request/header' ? event.data?.header?.config : undefined
        if (config && typeof config.provider === 'string' && config.provider.trim() !== '' && typeof config.model === 'string' && config.model.trim() !== '') {
          provider = config.provider
          model = config.model
          if (typeof config.reasoningEffort === 'string' && config.reasoningEffort.trim() !== '' && event?.data?.header?.adapterDefaults?.reasoningEffort !== true) reasoningEffort = config.reasoningEffort
          if (typeof config.maxTokens === 'number' && Number.isSafeInteger(config.maxTokens) && config.maxTokens > 0) maxTokens = config.maxTokens
          break
        }
      }
      if (!provider || !model) {
        const fallback = getService<AgentDefaultModelService>(ctx, 'agentDefaultModel')?.currentSelection?.()
        if (typeof fallback?.provider === 'string' && fallback.provider.trim() !== '' && typeof fallback.model === 'string' && fallback.model.trim() !== '') {
          provider = fallback.provider
          model = fallback.model
          if (typeof fallback.reasoningEffort === 'string' && fallback.reasoningEffort.trim() !== '') reasoningEffort = fallback.reasoningEffort
        }
      }
      if (!provider || !model) {
        console.log('bb: session resume skipped for ' + sessionId + ': no model selection available')
        return undefined
      }
      const handle = await agents.resume({
        resumeSessionId: sessionId,
        agentOptions: {
          provider, model,
          ...maxTokens === undefined ? {} : { maxTokens },
          ...reasoningEffort === undefined ? {} : { reasoningEffort },
        },
        setup: async (agentCtx: unknown) => {
          await presets.mount(agentCtx, resolved.id)
          // 0.1.1 does not consume AgentOptions.reasoningEffort. Seed its first
          // header through the scoped request seam, then let ordinary persisted
          // config and later UI model/effort selections own future requests.
          if (reasoningEffort !== undefined && typeof persistence.inspect === 'function') {
            const scoped = agentCtx as Context
            const disposeRequest = scoped.on('agent/request', async (_payload, next) => {
              const config = await next()
              if (config.provider !== provider || config.model !== model || config.reasoningEffort !== undefined) return config
              return { ...config, reasoningEffort: reasoningEffort as ReasoningEffortId }
            })
            const disposeHeader = scoped.on('session/event', (_session, event) => {
              if (event.type !== 'request/header') return
              void disposeRequest()
              void disposeHeader()
            })
          }
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
  // Both verified runtimes expose the actual durable Session header. Native
  // V4 retires generic plugin wrappers; this is the official V3→V4 spelling
  // for third-party producers, so new input and migrated history agree.
  const formatVersion = (agent.session?.header as { version: number } | undefined)?.version
  if (formatVersion !== 0 && formatVersion !== 4) {
    console.log('bb: unsupported session format; input not delivered')
    return false
  }
  const message = {
    id: sourcePlugin + '-' + Date.now().toString(36) + '-' + Math.floor(Math.random() * 1e9).toString(36),
    role: 'user',
    content: [{ type: 'text', text }],
    source: formatVersion === 4 ? { kind: 'plugin:' + sourcePlugin } : { kind: 'plugin', plugin: sourcePlugin },
  } as unknown as UserMessage
  agent.send(message, target, true)
  return true
}
