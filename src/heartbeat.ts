// dsh-heartbeat — 通用心跳组件（与任何频道无关）。
// 自持目标配置：$DSH_HOME/heartbeat-targets.json
//   { "标签": { "workspacePath": "…" } 或 { "sessionId": "…" }, "heartbeatMd": "可选自定义路径" }
// 定时向目标会话注入 HEARTBEAT 提示（默认读工作区根的 HEARTBEAT.md）。
// 依赖：timer + shell + fs（只读自己的配置文件）；不依赖 bluebubbles。

import type { Context, Plugin } from '@deepseek-ai/cordis'
import type { ShellExecRequest, ShellExecSpec, ShellRunResult } from '@deepseek-ai/dsh-shell'

import { getService, parseInterval, pickEnvValue, readEnvFiles, resolveSession, sendUserMessage } from './lib.ts'
import type { AgentsService, FsService, TimerService, WorkspaceRegistryService, SessionTarget } from './lib.ts'

interface HeartbeatTarget extends SessionTarget {
  heartbeatMd?: string
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

    async function tick(): Promise<void> {
      const entries = Object.entries(targets)
      if (entries.length === 0) return
      for (const [label, target] of entries) {
        if (!target || (!target.workspacePath && !target.sessionId)) continue
        try {
          const sessionId = await resolveSession(workspaces, target)
          if (!sessionId) continue
          const prompt = target.heartbeatMd
            ? 'Read ' + target.heartbeatMd + ' (workspace context). Follow it strictly. Do not infer or repeat old tasks from prior chats. If nothing needs attention, reply HEARTBEAT_OK.'
            : DEFAULT_PROMPT
          if (sendUserMessage(agents, sessionId, prompt, 'dsh-heartbeat', 'next-turn')) {
            console.log('hb: 心跳已投递 → ' + label)
          }
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
        const fileText = await readEnvFiles(ctx.shell, ['"$HOME/.dsh/.env"', '"$HOME/.zshenv"'])
        if (fileText) raw = pickEnvValue(fileText, 'BLUEBUBBLES_HEARTBEAT_INTERVAL') ?? undefined
      }
      const parsed = parseInterval(raw)
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
