// dsh-bluebubbles-heartbeat — 独立心跳行。
// 只依赖 timer + shell + bluebubbles 服务（由主桥行提供），
// 只负责：按 wall-clock 边界定时，向 heartbeat:true 且目标会话活跃的绑定
// 注入 OpenClaw 兼容的 HEARTBEAT 提示。不做任何频道相关的事。

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
interface BluebubblesBinding {
  workspacePath?: string
  sessionId?: string
  heartbeat?: boolean
}
interface BluebubblesService {
  listBindings(): Record<string, BluebubblesBinding>
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

const HEARTBEAT_PROMPT = 'Read HEARTBEAT.md if it exists (workspace context). Follow it strictly. Do not infer or repeat old tasks from prior chats. If nothing needs attention, reply HEARTBEAT_OK.'

export default {
  inject: {
    required: ['timer', 'shell'],
    optional: ['bluebubbles'],
  },
  apply(ctx: Context) {
    const timer = (ctx as unknown as { timer: TimerService }).timer
    const bluebubbles = (ctx as unknown as { bluebubbles?: BluebubblesService }).bluebubbles
    const agents = getService<AgentsService>(ctx, 'agents')
    const workspaces = getService<WorkspaceRegistryService>(ctx, 'workspaceRegistry')

    async function resolveSessionFor(binding: BluebubblesBinding): Promise<string | null> {
      if (binding && binding.sessionId) return binding.sessionId
      if (!binding || !binding.workspacePath || !workspaces) return null
      try {
        const ws = await workspaces.resolveByPath(binding.workspacePath)
        if (ws && Array.isArray(ws.sessionIds) && ws.sessionIds.length > 0) return ws.sessionIds[0] as string
      } catch (err) {
        console.log('bb-hb: 解析工作区失败：' + (err instanceof Error ? err.message : err))
      }
      return null
    }

    async function tick(): Promise<void> {
      if (!bluebubbles) return
      const bindings = bluebubbles.listBindings()
      const enabled = Object.entries(bindings).filter(([, b]) => b && b.heartbeat === true)
      if (enabled.length === 0) return
      for (const [key, binding] of enabled) {
        try {
          const sessionId = await resolveSessionFor(binding)
          if (!sessionId) continue
          const agent = agents ? agents.get(sessionId) : undefined
          if (!agent) continue
          const message = {
            id: 'bb-hb-' + Date.now().toString(36) + '-' + Math.floor(Math.random() * 1e9).toString(36),
            role: 'user',
            content: [{ type: 'text', text: HEARTBEAT_PROMPT }],
            source: { kind: 'plugin', plugin: 'dsh-bluebubbles-heartbeat' },
          } as unknown as UserMessage
          agent.send(message, 'next-turn', true)
          console.log('bb-hb: 心跳已投递 → ' + key)
        } catch (err) {
          console.log('bb-hb: 心跳投递失败 ' + key + '：' + (err instanceof Error ? err.message : err))
        }
      }
    }

    const bootstrap = async () => {
      if (!bluebubbles) {
        console.log('bb-hb: bluebubbles 服务未就绪，等待主桥行')
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
            console.log('bb-hb: 读取 ' + file + ' 失败：' + (err instanceof Error ? err.message : err))
          }
        }
      }
      const parsed = parseHeartbeatInterval(raw)
      const heartbeatMs = parsed !== null && parsed >= 60000 ? parsed : 12 * 60 * 60 * 1000

      const bindings = bluebubbles.listBindings()
      const hbEnabled = Object.values(bindings).some((b) => b && b.heartbeat === true)
      if (!hbEnabled) {
        console.log('bb-hb: 未启用（没有 heartbeat:true 的绑定）')
        return
      }
      const firstDelay = heartbeatMs - (Date.now() % heartbeatMs)
      ctx.effect(() => timer.timeout(() => {
        void tick()
        timer.interval(() => { void tick() }, heartbeatMs)
      }, firstDelay), 'heartbeat')
      console.log('bb-hb: 已启用，间隔 ' + Math.round(heartbeatMs / 3600000 * 10) / 10 + 'h，' + Math.round(firstDelay / 60000) + ' 分钟后首次触发')
    }
    void bootstrap()
  },
} satisfies Plugin
