// dsh-cron — 通用 cron 组件（与任何频道无关）。
// 自持任务配置：$DSH_HOME/cron-jobs.json
//   { "jobs": { "标签": { "schedule": "5 9 * * *", "target": { workspacePath|sessionId },
//                           "prompt": "…" 或 "promptFile": "绝对路径" } } }
// 到点把任务提示注入目标会话（next-turn）。调度用 one-shot timeout 链，
// 每次触发后计算下一次；重启/热重载不会在同一分钟重复触发。
// 依赖：timer + shell + fs（读任务配置与 promptFile）；复用 lib.ts 的会话解析与注入。

import type { Context, Plugin } from '@deepseek-ai/cordis'

import { getService, resolveSession, sendUserMessage } from './lib.ts'
import type { AgentsService, FsService, TimerService, WorkspaceRegistryService, SessionTarget } from './lib.ts'

interface CronJob {
  schedule: string
  target: SessionTarget
  prompt?: string
  promptFile?: string
}

// ---- 5 字段 cron（分 时 日 月 周；支持 * , - /；周 0=周日）----
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

/** 从 from（不含当分钟）起找下一个命中时刻，最多看 730 天。 */
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
    const jobsPath = (process.env.DSH_CRON_JOBS || dshHome + '/cron-jobs.json') as string

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
            console.log('cron: 跳过非法任务 ' + label)
            continue
          }
          const match = parseSchedule(job.schedule)
          if (!match) {
            console.log('cron: 跳过非法 schedule（' + job.schedule + '）任务 ' + label)
            continue
          }
          jobs[label] = job
          matches[label] = match
        }
        console.log('cron: 已载入 ' + Object.keys(jobs).length + ' 个任务')
      } catch (err) {
        console.log('cron: 任务配置载入跳过：' + (err instanceof Error ? err.message : err))
      }
    }

    async function fire(label: string): Promise<void> {
      const job = jobs[label]
      if (!job) return
      try {
        const sessionId = await resolveSession(workspaces, job.target)
        if (!sessionId) {
          console.log('cron: 目标无会话，跳过 ' + label)
          return
        }
        let text = typeof job.prompt === 'string' && job.prompt !== '' ? job.prompt : ''
        if (!text && job.promptFile && fs) {
          try {
            const target = await fs.resolve(job.promptFile)
            text = await fs.readText(target)
          } catch (err) {
            console.log('cron: promptFile 读取失败 ' + label + '：' + (err instanceof Error ? err.message : err))
          }
        }
        if (!text) text = 'Run the scheduled task "' + label + '".'
        if (sendUserMessage(agents, sessionId, text, 'dsh-cron', 'next-turn')) {
          console.log('cron: 已触发 ' + label + ' → ' + sessionId)
        } else {
          console.log('cron: 目标无活跃 agent，跳过 ' + label)
        }
      } catch (err) {
        console.log('cron: 触发失败 ' + label + '：' + (err instanceof Error ? err.message : err))
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
        console.log('cron: 未来 730 天内无命中')
        return
      }
      const delay = Math.max(1000, best.at.getTime() - Date.now() + 100)
      timer.timeout(() => {
        void fire(best.label)
        scheduleNext()
      }, delay)
      console.log('cron: 下一任务 "' + best.label + '" 于 ' + best.at.toLocaleString() + '（' + Math.round(delay / 60000) + ' 分钟后）')
    }

    const bootstrap = async () => {
      await loadJobs()
      if (Object.keys(matches).length === 0) {
        console.log('cron: 未启用（' + jobsPath + ' 为空或不存在）')
        return
      }
      scheduleNext()
    }
    void bootstrap()
  },
} satisfies Plugin
