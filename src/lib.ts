// src/lib.ts — dsh-bluebubbles 系列插件共享库（仅可擦除 TS 语法）。
// 被 src/index.ts / src/heartbeat.ts（以及未来的 src/cron.ts）以
// `import { … } from './lib.ts'` 引用——Node 原生类型剥离要求相对导入带 .ts 扩展名。

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import type { Workspace } from '@deepseek-ai/dsh-workspace'
import type { ShellExecRequest, ShellExecSpec, ShellRunResult } from '@deepseek-ai/dsh-shell'

// ================= 服务读取与结构视图 =================
export function getService<T>(ctx: Context, name: string): T | undefined {
  const raw = (ctx as unknown as { get(name: string): unknown }).get(name)
  return raw as T | undefined
}

export interface AgentsService {
  get(id: string): Agent | undefined
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

/** 目标会话引用（工作区路径或会话 ID，二选一）。 */
export interface SessionTarget {
  workspacePath?: string
  sessionId?: string
}

// ================= dotenv 解析 =================
export function pickEnvValue(text: string, name: string): string | null {
  const re = new RegExp('(?:^|\\n)\\s*(?:export\\s+)?' + name + '=(?:"([^"]*)"|\'([^\']*)\'|([^\\s"\']+))', 'm')
  const m = re.exec(text)
  if (!m) return null
  return (m[1] || m[2] || m[3] || '').trim()
}

/** 解析时间间隔："30m"/"2h"/"12h"/"90s"/"5000ms"；裸数字按小时。返回毫秒。 */
export function parseInterval(raw: string | undefined): number | null {
  if (raw === undefined || raw.trim() === '') return null
  const m = /^\s*(\d+(?:\.\d+)?)\s*(ms|s|m|h)?\s*$/i.exec(raw)
  if (!m) return null
  const n = Number(m[1])
  if (!Number.isFinite(n) || n <= 0) return null
  const unit = (m[2] || 'h').toLowerCase()
  return unit === 'ms' ? n : unit === 's' ? n * 1000 : unit === 'm' ? n * 60 * 1000 : n * 3600 * 1000
}

// ================= env 文件读取（.env/.zshenv 回退链） =================
/**
 * 依序读取文件列表，返回第一个非空文件的文本（DSH 的 .env 只在进程启动时
 * 由官方注入；插件热重载时靠这里自读，保证配置不丢）。
 */
export async function readEnvFiles(shell: ShellService, files: readonly string[]): Promise<string | null> {
  for (const file of files) {
    try {
      const spec: ShellExecSpec = shell.resolve({ command: 'cat ' + file + ' 2>/dev/null', timeoutMs: 8000, stdoutMaxBytes: 32768 } satisfies ShellExecRequest)
      const run: ShellRunResult = await shell.run(spec)
      if (run.exitCode === 0 && run.stdout && run.stdout.text) return run.stdout.text
    } catch {
      // 尝试下一个文件
    }
  }
  return null
}

// ================= 会话解析 =================
/** sessionId 优先；否则解析 workspacePath 的最新会话（sessionIds[0]）。 */
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
    console.log('lib: 解析工作区失败：' + (err instanceof Error ? err.message : err))
  }
  return null
}

// ================= 消息注入 =================
/**
 * 把一条文本以用户消息身份注入目标会话并唤醒。
 * @returns 是否成功投递（目标无活跃 agent 时返回 false，不抛错）。
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
