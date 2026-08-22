// dsh-cron — generic cron runner, channel-agnostic.
// Owns its job config: $DSH_HOME/cron-jobs.json
//   { "jobs": { "label": { "schedule": "5 9 * * *", "target": { workspacePath|sessionId },
//                          "prompt": "…" or "promptFile": "absolute path" } } }
// At each scheduled minute the prompt is injected into the target session
// (next-turn). Scheduling is a one-shot timeout chain: after every fire the
// next hit is recomputed, so a restart/hot reload never double-fires the
// current minute.
// After a successful injection, if the target session has a relay:true iMessage
// binding, armRelay on the bluebubbles service attaches auto-delivery of the
// session's replies — the same mode as phone-inbound turns, so task prompts
// must NOT tell the model to call send tools itself.
// Depends on timer + shell + fs (reads its own config and promptFile);
// the bluebubbles service is optional (relay delivery only).

import type { Context, Plugin } from '@deepseek-ai/cordis'

import { getService, resolveSession, sendUserMessage } from './lib.ts'
import type { AgentsService, FsService, TimerService, WorkspaceRegistryService, SessionTarget } from './lib.ts'

interface CronJob {
  schedule: string
  target: SessionTarget
  prompt?: string
  promptFile?: string
}

// Optional service provided by bluebubbles-bridge (src/index.ts provide('bluebubbles', …)).
interface BluebubblesService {
  listBindings(): Record<string, { sessionId?: string; relay?: boolean }>
  armRelay(args: { sessionId: string; chatGuid: string; relay?: boolean; typing?: boolean }): Promise<unknown>
}

// ---- 5-field cron (min hour dom month dow; * , - / supported; dow 0=Sunday) ----
function parseField(field: string, min: number, max: number): number[] | null {
  const out = new Set<number>()
  for (const part of field.split(',')) {
    const m = /^(\*|(\d+)(?:-(\d+))?)(?:\/(\d+))?$/.exec(part.trim())
    if (!m) return null
    const startStr = m[2]
    const endStr = m[3]
    const stepStr = m[4]
    const step = stepStr ? Number(stepStr) : 1
    if (!Number.isFinite(step) || step <= 0) return null
    let start = min
    let end = max
    if (startStr !== undefined) {
      start = Number(startStr)
      end = endStr !== undefined ? Number(endStr) : start
    }
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < min || end > max || start > end) return null
    for (let v = start; v <= end; v += step) out.add(v)
  }
  if (out.size === 0) return null
  return [...out].sort((a, b) => a - b)
}

type ScheduleMatch = (d: Date) => boolean

function parseSchedule(s: string): ScheduleMatch | null {
  const parts = s.trim().split(/\s+/)
  if (parts.length !== 5) return null
  const mins = parseField(parts[0], 0, 59)
  const hours = parseField(parts[1], 0, 23)
  const doms = parseField(parts[2], 1, 31)
  const months = parseField(parts[3], 1, 12)
  const dows = parseField(parts[4], 0, 6)
  if (!mins || !hours || !doms || !months || !dows) return null
  return (d) => mins.includes(d.getMinutes()) && hours.includes(d.getHours()) && doms.includes(d.getDate()) && months.includes(d.getMonth() + 1) && dows.includes(d.getDay())
}

/** Next hit after `from` (exclusive of the current minute), scanning at most 730 days ahead. */
function nextRunAfter(match: ScheduleMatch, from: Date, capDays = 730): Date | null {
  const t = new Date(from.getTime())
  t.setSeconds(0, 0)
  t.setMinutes(t.getMinutes() + 1)
  const cap = from.getTime() + capDays * 24 * 3600 * 1000
  while (t.getTime() <= cap) {
    if (match(t)) return t
    t.setMinutes(t.getMinutes() + 1)
  }
  return null
}

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
    const jobsPath = (process.env.CRON_JOBS || dshHome + '/cron-jobs.json') as string

    let jobs: Record<string, CronJob> = {}
    const matches: Record<string, ScheduleMatch> = {}

    async function loadJobs(): Promise<void> {
      if (!fs) return
      try {
        const target = await fs.resolve(jobsPath)
        const text = await fs.readText(target)
        const parsed: unknown = JSON.parse(text)
        const root = (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) ? parsed as { jobs?: Record<string, CronJob> } : null
        const raw = root && root.jobs && typeof root.jobs === 'object' ? root.jobs : {}
        for (const [label, job] of Object.entries(raw)) {
          if (!job || typeof job.schedule !== 'string' || !job.target || (!job.target.workspacePath && !job.target.sessionId)) {
            console.log('cron: skipping invalid job ' + label)
            continue
          }
          const match = parseSchedule(job.schedule)
          if (!match) {
            console.log('cron: skipping job ' + label + ' with invalid schedule (' + job.schedule + ')')
            continue
          }
          jobs[label] = job
          matches[label] = match
        }
        console.log('cron: loaded ' + Object.keys(jobs).length + ' jobs')
      } catch (err) {
        console.log('cron: job config load skipped: ' + (err instanceof Error ? err.message : err))
      }
    }

    // Arm reply auto-delivery when the target session has a relay:true iMessage
    // binding. The bridge hot-reloads the binding file on inbound messages; this
    // service view is current enough for cron. No binding / no service = skip
    // silently. Known limitation: only sessionId bindings match here; a
    // workspacePath binding is not reverse-resolved.
    async function armRelayIfBound(ctx: Context, sessionId: string, label: string): Promise<void> {
      const bb = getService<BluebubblesService>(ctx, 'bluebubbles')
      if (!bb) return
      try {
        const bindings = bb.listBindings() || {}
        for (const [key, binding] of Object.entries(bindings)) {
          if (!key.startsWith('chat:') || !binding) continue
          if (binding.sessionId !== sessionId || binding.relay !== true) continue
          await bb.armRelay({ sessionId, chatGuid: key.slice('chat:'.length), relay: true, typing: false })
          console.log('cron: relay armed ' + label + ' → ' + key.slice('chat:'.length))
          return
        }
      } catch (err) {
        console.log('cron: relay arm failed ' + label + ': ' + (err instanceof Error ? err.message : err))
      }
    }

    async function fire(label: string): Promise<void> {
      const job = jobs[label]
      if (!job) return
      try {
        const sessionId = await resolveSession(workspaces, job.target)
        if (!sessionId) {
          console.log('cron: target has no session, skipping ' + label)
          return
        }
        let text = typeof job.prompt === 'string' && job.prompt !== '' ? job.prompt : ''
        if (!text && job.promptFile && fs) {
          try {
            const target = await fs.resolve(job.promptFile)
            text = await fs.readText(target)
          } catch (err) {
            console.log('cron: promptFile read failed ' + label + ': ' + (err instanceof Error ? err.message : err))
          }
        }
        if (!text) text = 'Run the scheduled task "' + label + '".'
        if (sendUserMessage(agents, sessionId, text, 'dsh-cron', 'next-turn')) {
          console.log('cron: fired ' + label + ' → ' + sessionId)
          await armRelayIfBound(ctx, sessionId, label)
        } else {
          console.log('cron: target has no live agent, skipping ' + label)
        }
      } catch (err) {
        console.log('cron: fire failed ' + label + ': ' + (err instanceof Error ? err.message : err))
      }
    }

    function scheduleNext(): void {
      let best: { label: string; at: Date } | null = null
      const now = new Date()
      for (const [label, match] of Object.entries(matches)) {
        const next = nextRunAfter(match, now)
        if (next && (!best || next.getTime() < best.at.getTime())) best = { label, at: next }
      }
      if (!best) {
        console.log('cron: no hit within the next 730 days')
        return
      }
      const delay = Math.max(1000, best.at.getTime() - Date.now() + 100)
      timer.timeout(() => {
        void fire(best.label)
        scheduleNext()
      }, delay)
      console.log('cron: next job "' + best.label + '" at ' + best.at.toLocaleString() + ' (in ' + Math.round(delay / 60000) + ' min)')
    }

    const bootstrap = async () => {
      await loadJobs()
      if (Object.keys(matches).length === 0) {
        console.log('cron: disabled (' + jobsPath + ' empty or missing)')
        return
      }
      scheduleNext()
    }
    void bootstrap()
  },
} satisfies Plugin
