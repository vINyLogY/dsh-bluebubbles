// dsh-heartbeat — generic periodic wake-up, channel-agnostic.
// Owns its target config: $DSH_HOME/heartbeat-targets.json
//   { "label": { "workspacePath": "…" } or { "sessionId": "…" }, "heartbeatMd": "optional custom path" }
// Injects a HEARTBEAT prompt into the target session on an interval (the
// default prompt reads HEARTBEAT.md at the workspace root).
// Depends on timer + shell + fs (reads only its own config); no bluebubbles.

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
    const targetsPath = (process.env.HEARTBEAT_TARGETS || dshHome + '/heartbeat-targets.json') as string

    let targets: Record<string, HeartbeatTarget> = {}

    async function loadTargets(): Promise<void> {
      if (!fs) return
      try {
        const target = await fs.resolve(targetsPath)
        const text = await fs.readText(target)
        const parsed: unknown = JSON.parse(text)
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          targets = parsed as Record<string, HeartbeatTarget>
          console.log('hb: loaded heartbeat targets (' + Object.keys(parsed).length + ')')
        }
      } catch (err) {
        console.log('hb: heartbeat target load skipped: ' + (err instanceof Error ? err.message : err))
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
            console.log('hb: heartbeat delivered → ' + label)
          }
        } catch (err) {
          console.log('hb: heartbeat delivery failed ' + label + ': ' + (err instanceof Error ? err.message : err))
        }
      }
    }

    const bootstrap = async () => {
      await loadTargets()
      if (Object.keys(targets).length === 0) {
        console.log('hb: disabled (' + targetsPath + ' empty or missing)')
        return
      }
      let raw = process.env.HEARTBEAT_INTERVAL
      if (raw === undefined) {
        const fileText = await readEnvFiles(ctx.shell, ['"$HOME/.dsh/.env"', '"$HOME/.zshenv"'])
        if (fileText) raw = pickEnvValue(fileText, 'HEARTBEAT_INTERVAL') ?? undefined
      }
      const parsed = parseInterval(raw)
      const heartbeatMs = parsed !== null && parsed >= 60000 ? parsed : 12 * 60 * 60 * 1000
      // Align the first tick to the wall-clock interval boundary so a restart
      // does not shift the daily rhythm by whenever the process happened to boot.
      const firstDelay = heartbeatMs - (Date.now() % heartbeatMs)
      // Both the first-shot timeout and the interval it creates must stay
      // fiber-owned: an interval created inside the callback without capturing
      // its disposer survives stop/HMR and keeps beating.
      ctx.effect(() => {
        let stopInterval: (() => void) | null = null
        const stopFirst = timer.timeout(() => {
          void tick()
          stopInterval = timer.interval(() => { void tick() }, heartbeatMs)
        }, firstDelay)
        return () => {
          stopFirst()
          if (stopInterval) stopInterval()
        }
      }, 'heartbeat')
      console.log('hb: enabled, interval ' + Math.round(heartbeatMs / 3600000 * 10) / 10 + 'h, first tick in ' + Math.round(firstDelay / 60000) + ' min')
    }
    void bootstrap()
  },
} satisfies Plugin
