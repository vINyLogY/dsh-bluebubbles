// dsh-heartbeat — 通用心跳组件（与任何频道无关）。
// 自持目标配置：$DSH_HOME/heartbeat-targets.json
//   { "标签": { "workspacePath": "…" } 或 { "sessionId": "…" }, "heartbeatMd": "可选自定义路径" }
// 定时向目标会话注入 HEARTBEAT 提示（默认读工作区根的 HEARTBEAT.md）。
// 依赖：timer + shell + fs（只读自己的配置文件）；不依赖 bluebubbles。

import type { Context, Plugin } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import type { Workspace } from '@deepseek-ai/dsh-workspace'
import type { ShellExecRequest, ShellExecSpec, ShellRunResult } from '@deepseek-ai/dsh-shell'

interface TimerService {
  interval(callback: () => void, delay: number): () => void
  timeout(callback: () => void, delay: number): () => void
}
interface AgentsService {
  get(id: string): Agent | undefined
}
interface WorkspaceRegistryService {
  resolveByPath(path: string): Promise<Workspace | undefined>
}
interface FsTarget {}
interface FsService {
  resolve(path: string): Promise<FsTarget>
  readText(target: FsTarget): Promise<string>
}
interface HeartbeatTarget {
  workspacePath?: string
  sessionId?: string
  heartbeatMd?: string
}

function getService<T>(ctx: Context, name: string): T | undefined {
  const raw = (ctx as unknown as { get(name: string): unknown }).get(name)
  return raw as T | undefined
}

function pickEnvValue(text: string, name: string): string | null {
  const re = new RegExp('(?:^|\\n)\\s*(?:export\\s+)?' + name + '=(?:"([^"]*)"|\'([^\']*)\'|([^\\s"\']+))', 'm')
  const m = re.exec(text)
  if (!m) return null
  return (m[1] || m[2] || m[3] || '').trim()
}

// "30m"/"2h"/"12h"/"90s"；裸数字按小时
function parseHeartbeatInterval(raw: string | undefined): number | null {
  if (raw === undefined || raw.trim() === '') return null
  const m = /^\s*(\d+(?:\.\d+)?)\s*(ms|s|m|h)?\s*$/i.exec(raw)
  if (!m) return null
  const n = Number(m[1])
  if (!Number.isFinite(n) || n <= 0) return null
  const unit = (m[2] || 'h').toLowerCase()
  return unit === 'ms' ? n : unit === 's' ? n * 1000 : unit === 'm' ? n * 60 * 1000 : n * 3600 * 1000
}

const DEFAULT_PROMPT = 'Read HEARTBEAT.md if it exists (workspace context). Follow it strictly. Do not infer or repeat old tasks from prior chats. If nothing needs attention, reply HEARTBEAT_OK.'

export default {
  inject: {
    required: ['timer', 'shell'],
    optional: ['fs'],
  },
  apply(ctx: Context) {
    const timer = (ctx as unknown as { timer: TimerService }).timer
    const fs = getService<FsService>(ctx, 'fs')
    const agents = getService<AgentsService>(ctx, 'agents')
    const workspaces = getService<WorkspaceRegistryService>(ctx, 'workspaceRegistry')
    const dshHome = (process.env.DSH_HOME || process.env.HOME + '/.dsh') as string
    const targetsPath = (process.env.BLUEBUBBLES_HEARTBEAT_TARGETS || dshHome + '/heartbeat-targets.json') as string

    let targets: Record<string, HeartbeatTarget> = {}

    async function loadTargets(): Promise<void> {
      if (!fs) return
      try {
        const target = await fs.resolve(targetsPath)
        const text = await fs.readText(target)
        const parsed: unknown = JSON.parse(text)
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          targets = parsed as Record<string, HeartbeatTarget>
          console.log('hb: 已载入心跳目标（' + Object.keys(parsed).length + ' 个）')
        }
      } catch (err) {
        console.log('hb: 心跳目标载入跳过：' + (err instanceof Error ? err.message : err))
      }
    }

    async function resolveSessionFor(t: HeartbeatTarget): Promise<string | null> {
      if (t && t.sessionId) return t.sessionId
      if (!t || !t.workspacePath || !workspaces) return null
      try {
        const ws = await workspaces.resolveByPath(t.workspacePath)
        if (ws && Array.isArray(ws.sessionIds) && ws.sessionIds.length > 0) return ws.sessionIds[0] as string
      } catch (err) {
        console.log('hb: 解析工作区失败：' + (err instanceof Error ? err.message : err))
      }
      return null
    }

    async function tick(): Promise<void> {
      const entries = Object.entries(targets)
      if (entries.length === 0) return
      for (const [label, target] of entries) {
        if (!target || (!target.workspacePath && !target.sessionId)) continue
        try {
          const sessionId = await resolveSessionFor(target)
          if (!sessionId) continue
          const agent = agents ? agents.get(sessionId) : undefined
          if (!agent) continue
          const prompt = target.heartbeatMd
            ? 'Read ' + target.heartbeatMd + ' (workspace context). Follow it strictly. Do not infer or repeat old tasks from prior chats. If nothing needs attention, reply HEARTBEAT_OK.'
            : DEFAULT_PROMPT
          const message = {
            id: 'hb-' + Date.now().toString(36) + '-' + Math.floor(Math.random() * 1e9).toString(36),
            role: 'user',
            content: [{ type: 'text', text: prompt }],
            source: { kind: 'plugin', plugin: 'dsh-heartbeat' },
          } as unknown as UserMessage
          agent.send(message, 'next-turn', true)
          console.log('hb: 心跳已投递 → ' + label)
        } catch (err) {
          console.log('hb: 心跳投递失败 ' + label + '：' + (err instanceof Error ? err.message : err))
        }
      }
    }

    const bootstrap = async () => {
      await loadTargets()
      if (Object.keys(targets).length === 0) {
        console.log('hb: 未启用（' + targetsPath + ' 为空或不存在）')
        return
      }
      let raw = process.env.BLUEBUBBLES_HEARTBEAT_INTERVAL
      if (raw === undefined) {
        for (const file of ['"$HOME/.dsh/.env"', '"$HOME/.zshenv"']) {
          try {
            const spec: ShellExecSpec = ctx.shell.resolve({ command: 'cat ' + file + ' 2>/dev/null', timeoutMs: 8000, stdoutMaxBytes: 32768 } satisfies ShellExecRequest)
            const run: ShellRunResult = await ctx.shell.run(spec)
            if (run.exitCode === 0 && run.stdout && run.stdout.text) {
              const fromFile = pickEnvValue(run.stdout.text, 'BLUEBUBBLES_HEARTBEAT_INTERVAL')
              if (fromFile) raw = fromFile
              break
            }
          } catch (err) {
            console.log('hb: 读取 ' + file + ' 失败：' + (err instanceof Error ? err.message : err))
          }
        }
      }
      const parsed = parseHeartbeatInterval(raw)
      const heartbeatMs = parsed !== null && parsed >= 60000 ? parsed : 12 * 60 * 60 * 1000
      const firstDelay = heartbeatMs - (Date.now() % heartbeatMs)
      ctx.effect(() => timer.timeout(() => {
        void tick()
        timer.interval(() => { void tick() }, heartbeatMs)
      }, firstDelay), 'heartbeat')
      console.log('hb: 已启用，间隔 ' + Math.round(heartbeatMs / 3600000 * 10) / 10 + 'h，' + Math.round(firstDelay / 60000) + ' 分钟后首次触发')
    }
    void bootstrap()
  },
} satisfies Plugin
