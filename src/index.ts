// dsh-bluebubbles — BlueBubbles (iMessage) bridge plugin for DeepSeek Harness.
// Real host-composition plugin (TypeScript, erasable-syntax only): runs in the
// DSH host process under Node >= 23.6 native type stripping, no build step.
//
// Secrets come from BLUEBUBBLES_PASSWORD env or a ~/.zshenv fallback; this
// repository never contains credentials.

import type { Context, Plugin } from '@deepseek-ai/cordis'
import type { ToolDefinition, PreToolDecision } from '@deepseek-ai/dsh-tools'
import type { ApprovalOutcome } from '@deepseek-ai/dsh-user-approval'
import type { ShellExecRequest, ShellExecSpec, ShellRunResult } from '@deepseek-ai/dsh-shell'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { BindingError, readBindings, updateBindings, withBindingsLock } from './bindings-store.ts'

import { ensureLiveAgent, getService, inspectSession, pickEnvValue, readEnvFiles, resolveSession, sendUserMessage, runShell } from './lib.ts'
import type { SessionPersistenceService, AgentPresetsService } from './lib.ts'
import type { AgentsService, FsService, WorkspaceRegistryService } from './lib.ts'

interface WebServerService {
  register(route: WebRoute): () => void
}

interface Binding {
  workspacePath?: string
  sessionId?: string
  /** For iMessage-triggered turns: auto-deliver assistant text replies back to that chat (no tool call needed) */
  relay?: boolean
  /** For iMessage-triggered turns: show "typing…" to the peer while working (on by default) */
  typing?: boolean
}

export default {
  inject: ['tools', 'shell', 'webServer', 'agents', 'fs', 'workspaceRegistry'],
  apply(ctx: Context) {
    const webServer = getService<WebServerService>(ctx, 'webServer')
    const agents = getService<AgentsService>(ctx, 'agents')
    const fs = getService<FsService>(ctx, 'fs')
    const workspaces = getService<WorkspaceRegistryService>(ctx, 'workspaceRegistry')
    let bindingMutation: Promise<unknown> | undefined
    let inboundAdmissions = 0
    const outgoingChats = new Map<string, number>()
    const pendingRelays = new Set<Promise<unknown>>()
    let relayDispatchTail: Promise<unknown> = Promise.resolve()

    const dshHome = (process.env.DSH_HOME || process.env.HOME + '/.dsh') as string

    const state = {
      baseUrl: (process.env.BLUEBUBBLES_BASE_URL || 'http://localhost:1234') as string,
      password: (process.env.BLUEBUBBLES_PASSWORD || '') as string,
      bindings: {} as Record<string, Binding>,
      bindingsPath: (process.env.BLUEBUBBLES_BINDINGS || dshHome + '/bluebubbles-bindings.json') as string,
      contacts: {} as Record<string, string>,
      contactsPath: (process.env.BLUEBUBBLES_CONTACTS || dshHome + '/bluebubbles-contacts.json') as string,
      relayStatePath: (process.env.BLUEBUBBLES_RELAY_STATE || dshHome + '/bluebubbles-relay-state.json') as string,
    }

    // ================= HTTP helpers (curl via the shell service: the host web service only accepts GET) =================
    function base(): string {
      return state.baseUrl.replace(/\/+$/, '')
    }

    function endpoint(path: string): string {
      const sep = path.indexOf('?') === -1 ? '?' : '&'
      return base() + '/api/v1/' + path + sep + 'password=' + encodeURIComponent(state.password)
    }

    function shEscape(value: string): string {
      return value.replace(/'/g, "'\\''")
    }

    async function curl(method: string, path: string, body: unknown): Promise<{ ok: boolean; data?: unknown; error?: string }> {
      const url = endpoint(path)
      let command: string
      if (body === null || body === undefined) {
        command = "curl -sS -m 20 '" + shEscape(url) + "'"
      } else {
        const json = JSON.stringify(body).replace(/'/g, "'\\''")
        command = "curl -sS -m 30 -X " + method + " -H 'Content-Type: application/json' --data-raw '" + json + "' '" + shEscape(url) + "'"
      }
      const spec: ShellExecSpec = ctx.shell.resolve({ command, timeoutMs: 35000, stdoutMaxBytes: 262144 } satisfies ShellExecRequest)
      const run: ShellRunResult = await runShell(ctx.shell, spec)
      if (run.exitCode !== 0) {
        const detail = ((run.stderr && run.stderr.text) ? run.stderr.text : (run.stdout ? run.stdout.text : '')).trim()
        return { ok: false, error: 'curl exit ' + run.exitCode + (run.timedOut ? ' (timeout)' : '') + (detail ? ': ' + detail.slice(0, 300) : '') }
      }
      let parsed: any = null
      try {
        parsed = JSON.parse((run.stdout && run.stdout.text) || '')
      } catch {
        return { ok: false, error: 'cannot parse BlueBubbles response: ' + ((run.stdout && run.stdout.text) || '').slice(0, 300) }
      }
      if (parsed && typeof parsed.status === 'number' && parsed.status >= 400) {
        const detail = parsed.error ? (parsed.error.message || parsed.error.error || parsed.error.type || JSON.stringify(parsed.error)) : (parsed.message || 'HTTP ' + parsed.status)
        return { ok: false, error: detail }
      }
      const hasData = parsed && Object.prototype.hasOwnProperty.call(parsed, 'data')
      return { ok: true, data: hasData ? parsed.data : parsed }
    }

    async function curlMultipart(path: string, fields: Record<string, string>, filePath: string, fileName: string): Promise<{ ok: boolean; data?: unknown; error?: string }> {
      const url = endpoint(path)
      const parts: string[] = ["curl -sS -m 60 -X POST"]
      for (const [key, value] of Object.entries(fields)) {
        // --form-string passes values literally; a chatGuid containing ';' or '+' would be mangled by curl's -F syntax
        parts.push("--form-string '" + shEscape(key + '=' + value) + "'")
      }
      parts.push("-F 'attachment=@" + shEscape(filePath) + ";filename=" + shEscape(fileName) + "'")
      parts.push("'" + shEscape(url) + "'")
      const command = parts.join(' ')
      const spec: ShellExecSpec = ctx.shell.resolve({ command, timeoutMs: 70000, stdoutMaxBytes: 262144 } satisfies ShellExecRequest)
      const run: ShellRunResult = await runShell(ctx.shell, spec)
      if (run.exitCode !== 0) {
        const detail = ((run.stderr && run.stderr.text) ? run.stderr.text : (run.stdout ? run.stdout.text : '')).trim()
        return { ok: false, error: 'curl exit ' + run.exitCode + (run.timedOut ? ' (timeout)' : '') + (detail ? ': ' + detail.slice(0, 300) : '') }
      }
      let parsed: any = null
      try {
        parsed = JSON.parse((run.stdout && run.stdout.text) || '')
      } catch {
        return { ok: false, error: 'cannot parse BlueBubbles response: ' + ((run.stdout && run.stdout.text) || '').slice(0, 300) }
      }
      if (parsed && typeof parsed.status === 'number' && parsed.status >= 400) {
        const detail = parsed.error ? (parsed.error.message || parsed.error.error || parsed.error.type || JSON.stringify(parsed.error)) : (parsed.message || 'HTTP ' + parsed.status)
        return { ok: false, error: detail }
      }
      const hasData = parsed && Object.prototype.hasOwnProperty.call(parsed, 'data')
      return { ok: true, data: hasData ? parsed.data : parsed }
    }

    // ================= compact serializers =================
    function compactMessage(m: Record<string, any>): Record<string, unknown> {
      return {
        guid: m.guid,
        text: m.text,
        isFromMe: !!m.isFromMe,
        dateCreated: m.dateCreated ?? null,
        dateRead: m.dateRead ?? null,
        itemType: m.itemType ?? null,
      }
    }

    function compactChat(c: Record<string, any>): Record<string, unknown> {
      return {
        guid: c.guid,
        displayName: c.displayName,
        style: c.style,
        chatIdentifier: c.chatIdentifier,
        participants: Array.isArray(c.participants) ? c.participants.map((p: any) => p.address) : [],
        lastMessage: c.lastMessage ? compactMessage(c.lastMessage) : null,
      }
    }

    // ================= business operations =================
    async function ping(): Promise<Record<string, unknown>> {
      const started = Date.now()
      const result = await curl('GET', 'ping', null)
      if (!result.ok) return result
      return { ok: true, latencyMs: Date.now() - started, server: result.data }
    }

    function applyConfig(args: Record<string, unknown>): { baseUrl: string; hasPassword: boolean } {
      if (args && typeof args.baseUrl === 'string' && args.baseUrl.trim() !== '') state.baseUrl = args.baseUrl.trim()
      if (args && typeof args.password === 'string' && args.password !== '') state.password = args.password
      return { baseUrl: state.baseUrl, hasPassword: state.password !== '' }
    }

    async function listChats(args: Record<string, unknown>): Promise<Record<string, unknown>> {
      const limit = typeof args.limit === 'number' ? Math.min(Math.max(Math.floor(args.limit), 1), 100) : 50
      const result = await curl('POST', 'chat/query', { limit, offset: 0, sort: 'lastmessage', with: ['lastmessage', 'participants'] })
      if (!result.ok) return result
      const chats = Array.isArray(result.data) ? result.data : []
      return { ok: true, total: chats.length, chats: chats.map(compactChat) }
    }

    async function getMessages(args: Record<string, unknown>): Promise<Record<string, unknown>> {
      const guid = String(args.chatGuid)
      const limit = typeof args.limit === 'number' ? Math.min(Math.max(Math.floor(args.limit), 1), 100) : 25
      const result = await curl('GET', 'chat/' + encodeURIComponent(guid) + '/message?limit=' + limit + '&sort=DESC', null)
      if (!result.ok) return result
      const messages = Array.isArray(result.data) ? result.data : []
      return { ok: true, count: messages.length, messages: messages.map(compactMessage) }
    }

    async function sendText(args: Record<string, unknown>): Promise<Record<string, unknown>> {
      if (bindingMutation) await bindingMutation.catch(() => {})
      const outgoingChat = String(args.chatGuid)
      outgoingChats.set(outgoingChat, (outgoingChats.get(outgoingChat) || 0) + 1)
      try {
      const tempGuid = 'dsh-' + Date.now().toString(36) + '-' + Math.floor(Math.random() * 1e9).toString(36)
      const method = args.method === 'private-api' ? 'private-api' : 'apple-script'
      noteSent(String(args.chatGuid), String(args.text))
      const result = await curl('POST', 'message/text', {
        chatGuid: String(args.chatGuid),
        tempGuid,
        message: String(args.text),
        method,
      })
      if (!result.ok) return result
      const sentGuid = result.data && (result.data as any).guid ? (result.data as any).guid : null
      if (sentGuid) seenGuids.add(sentGuid)
      return { ok: true, tempGuid, guid: sentGuid, text: result.data && (result.data as any).text ? (result.data as any).text : null }
      } finally {
        const remaining = (outgoingChats.get(outgoingChat) || 1) - 1
        if (remaining) outgoingChats.set(outgoingChat, remaining)
        else outgoingChats.delete(outgoingChat)
      }
    }

    async function sendAttachment(args: Record<string, unknown>): Promise<Record<string, unknown>> {
      if (bindingMutation) await bindingMutation.catch(() => {})
      const outgoingChat = String(args.chatGuid)
      outgoingChats.set(outgoingChat, (outgoingChats.get(outgoingChat) || 0) + 1)
      try {
      const filePath = String(args.filePath)
      const tempGuid = 'dsh-' + Date.now().toString(36) + '-' + Math.floor(Math.random() * 1e9).toString(36)
      const name = typeof args.name === 'string' && args.name.trim() !== '' ? args.name.trim() : (filePath.split('/').pop() || 'attachment')
      const method = args.method === 'apple-script' ? 'apple-script' : 'private-api'
      noteSent(String(args.chatGuid), '')
      const result = await curlMultipart('message/attachment', {
        chatGuid: String(args.chatGuid),
        tempGuid,
        method,
        name,
      }, filePath, name)
      if (!result.ok) return result
      const sentGuid = result.data && (result.data as any).guid ? (result.data as any).guid : null
      if (sentGuid) seenGuids.add(sentGuid)
      return { ok: true, tempGuid, name, guid: sentGuid }
      } finally {
        const remaining = (outgoingChats.get(outgoingChat) || 1) - 1
        if (remaining) outgoingChats.set(outgoingChat, remaining)
        else outgoingChats.delete(outgoingChat)
      }
    }

    // ================= state files (bindings + contacts) =================
    // Both are edited directly by the bb-channel CLI; re-reading them before
    // every inbound message gives hot updates with no reload machinery.
    async function readJsonFile(path: string): Promise<Record<string, unknown> | null> {
      if (!fs) return null
      try {
        const target = await fs.resolve(path)
        const parsed: unknown = JSON.parse(await fs.readText(target))
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>
      } catch {
        // missing or corrupt file = treat as empty
      }
      return null
    }

    async function reloadStateFiles(log: boolean): Promise<void> {
      const b = await readJsonFile(state.bindingsPath)
      if (b) {
        state.bindings = b as unknown as Record<string, Binding>
        if (log) console.log('bb: loaded bindings (' + Object.keys(b).length + ')')
      }
      const c = await readJsonFile(state.contactsPath)
      if (c) state.contacts = c as Record<string, string>
    }

    async function bindingView() {
      const snapshot = await readBindings(state.bindingsPath)
      const persistence = getService<SessionPersistenceService>(ctx, 'sessionPersistence')
      const existing = persistence ? new Set((await persistence.list()).map(row => row.header?.id ?? row.id)) : new Set<string>()
      const targets = await Promise.all(Object.entries(snapshot.bindings).map(async ([key, row]) => ({key, row, resolved: await resolveSession(workspaces, row)})))
      return { revision: snapshot.revision, bindings: targets.map(({key, row, resolved}) => ({
        key, chatGuid: key.startsWith('chat:') ? key.slice(5) : null,
        sessionId: typeof row.sessionId === 'string' ? row.sessionId : null,
        workspacePath: typeof row.workspacePath === 'string' ? row.workspacePath : null,
        relay: row.relay === true, typing: row.typing !== false,
        status: !resolved || !existing.has(resolved) ? 'dangling' : 'bound',
        conflict: !!resolved && targets.some(other => other.key !== key && other.resolved === resolved),
      })) }
    }

    async function validateBindingSession(id: string) {
      const persistence = getService<SessionPersistenceService>(ctx, 'sessionPersistence')
      const presets = getService<AgentPresetsService>(ctx, 'agentPresets')
      if (!persistence || !presets) throw new BindingError('preset-unavailable')
      if (!(await persistence.list()).some(row => (row.header?.id ?? row.id) === id)) throw new BindingError('not-found')
      const stored = await inspectSession(persistence, id)
      if (!stored || stored.meta.origin === 'subagent') throw new BindingError('not-found')
      let presetId = stored.meta.agentPreset
      for (const event of stored.events) if (event.type === 'agent-preset/selected') presetId = event.data?.agentPreset
      try {
        const preset = await presets.resolve(presetId) as { id: string; broken?: string }
        if (preset.broken) throw new BindingError('preset-unavailable')
      } catch { throw new BindingError('preset-unavailable') }
    }

    function mutateBinding(args: {chatGuid: string; sessionId?: string; relay?: boolean; expectedRevision: string}, mode: 'bind' | 'unbind' | 'relay') {
      if (bindingMutation) return Promise.reject(new BindingError('busy'))
      const task = (async () => {
        const affected = new Set<string>()
        const snapshot = await updateBindings(state.bindingsPath, args.expectedRevision, async table => {
          if (inboundAdmissions || outgoingChats.size || inboundTriggers.size || pendingRelays.size) throw new BindingError('busy')
          const key = 'chat:' + args.chatGuid
          const previous = table[key] && await resolveSession(workspaces, table[key])
          if (previous) affected.add(previous)
          if (args.sessionId) affected.add(args.sessionId)
          if (mode === 'bind') {
            const chat = await curl('GET', 'chat/' + encodeURIComponent(args.chatGuid), null)
            if (!chat.ok || !chat.data || (chat.data as {guid?: string}).guid !== args.chatGuid) throw new BindingError('chat-unavailable')
            await validateBindingSession(args.sessionId!)
            for (const [otherKey, target] of Object.entries(table)) if (otherKey !== key && await resolveSession(workspaces, target) === args.sessionId) throw new BindingError('session-conflict')
            const row = {...table[key], sessionId: args.sessionId, relay: args.relay}
            delete row.workspacePath
            table[key] = row
          } else if (mode === 'unbind') delete table[key]
          else {
            if (!table[key]) throw new BindingError('not-found')
            table[key] = {...table[key], relay: args.relay}
          }
          // Inbound admissions wait on task; tool/scheduler sends may start while
          // validation awaits, so recheck immediately before returning to publish.
          if (inboundAdmissions || outgoingChats.size || inboundTriggers.size || pendingRelays.size) throw new BindingError('busy')
        }, async publish => {
          const ids = [...affected]
          const reserve = async (index: number): Promise<Awaited<ReturnType<typeof publish>>> => {
            if (index === ids.length) return publish()
            const live = agents?.get(ids[index])
            if (!live) return reserve(index + 1)
            if (live.status !== 'idle' || typeof live.runMaintenance !== 'function') throw new BindingError('busy')
            try { return await live.runMaintenance(() => reserve(index + 1)) }
            catch (error) { if (error instanceof BindingError) throw error; throw new BindingError('busy') }
          }
          return reserve(0)
        })
        state.bindings = snapshot.bindings
        return bindingView()
      })()
      bindingMutation = task
      void task.finally(() => { if (bindingMutation === task) bindingMutation = undefined }).catch(() => {})
      return task
    }

    // ================= webhook: self-registration with BlueBubbles =================
    const WEBHOOK_URL = 'http://127.0.0.1:3080/bluebubbles/webhook'

    async function ensureWebhook(): Promise<Record<string, unknown>> {
      if (!webServer) return { ok: false, registered: false, error: 'webServer service unavailable; cannot receive pushes' }
      if (state.password === '') return { ok: false, registered: false, error: 'BlueBubbles password not configured' }
      // idempotent: check before create, never rely on server-side dedup of duplicate URLs
      const list = await curl('GET', 'webhook', null)
      const existing = list.ok && Array.isArray(list.data) ? list.data.find((w: any) => w && w.url === WEBHOOK_URL) : null
      if (existing) return { ok: true, registered: true, id: existing.id, url: WEBHOOK_URL, note: 'already exists' }
      const created = await curl('POST', 'webhook', { url: WEBHOOK_URL, events: ['new-message'] })
      if (created.ok) {
        const data = created.data as any
        return { ok: true, registered: true, id: data && data.id ? data.id : null, url: WEBHOOK_URL }
      }
      return { ok: false, registered: false, error: created.error }
    }

    // ================= webhook event handling (with message-level dedup) =================
    const seenGuids = new Set<string>()
    const SEEN_GUIDS_MAX = 500
    // Anti-self-loop: every send is recorded as (chat, text) first; webhook echoes
    // of isFromMe messages are matched against this queue and dropped. This is the
    // primary defense because the webhook does not always echo tempGuid back.
    const pendingSent: Array<{ chat: string; text: string; at: number }> = []
    const PENDING_TTL = 60000
    // webhook and REST texts may differ in unicode normalization (NFC/NFD); normalize before comparing
    function normText(t: string): string { return t.normalize('NFC').trim() }
    function noteSent(chat: string, text: string): void {
      pendingSent.push({ chat, text: normText(text), at: Date.now() })
      if (pendingSent.length > 100) pendingSent.splice(0, pendingSent.length - 100)
    }
    function matchPending(chat: string | null, text: string): boolean {
      const now = Date.now()
      while (pendingSent.length > 0 && now - pendingSent[0].at > PENDING_TTL) pendingSent.shift()
      if (!chat) return false
      const needle = normText(text)
      for (let i = pendingSent.length - 1; i >= 0; i--) {
        const p = pendingSent[i]
        if (p.chat === chat && p.text === needle) {
          pendingSent.splice(i, 1)
          return true
        }
      }
      return false
    }
    function readBody(req: IncomingMessage): Promise<string> {
      return new Promise((resolve, reject) => {
        let size = 0
        const chunks: Buffer[] = []
        req.on('data', (chunk: Buffer) => {
          size += chunk.length
          if (size > 1024 * 1024) {
            reject(new Error('body too large'))
            req.destroy()
            return
          }
          chunks.push(chunk)
        })
        req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
        req.on('error', reject)
      })
    }

    async function onWebhook(req: IncomingMessage, res: ServerResponse): Promise<void> {
      const remote = (req.socket && req.socket.remoteAddress) || ''
      const loopback = remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1'
      if (!loopback) {
        res.statusCode = 403
        res.end('forbidden')
        return
      }
      let raw: string
      try {
        raw = await readBody(req)
      } catch {
        if (!res.headersSent) {
          res.statusCode = 400
          res.end('bad request')
        }
        return
      }
      res.statusCode = 200
      // Version marker must match the ?v=N in the host cordis.patch.yml row —
      // README's update procedure verifies the live build through this string.
      res.end('ok-v33')
      let event: { type?: string; data?: any } | null = null
      try {
        event = JSON.parse(raw)
      } catch {
        return
      }
      processEvent(event).catch((err) => console.log('bb: webhook event handling failed: ' + (err instanceof Error ? err.message : err)))
    }

    // ================= attachment download (inbound media) =================
    function fmtBytes(n: number): string {
      if (n >= 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + 'MB'
      if (n >= 1024) return Math.round(n / 1024) + 'KB'
      return n + 'B'
    }

    // message timestamp for the relay header: Apple epoch (2001-01-01) ms and Unix ms both show up
    // depending on the BlueBubbles build, so disambiguate by magnitude
    function toUnixMs(raw: unknown): number | null {
      if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) return null
      return raw < 1e12 ? raw + 978307200000 : raw
    }

    // relay header timestamps render in the host timezone unless BLUEBUBBLES_TZ overrides it,
    // and always carry the offset so the stamp stays unambiguous. The stamp is decoration: any
    // failure here must degrade to a plain local stamp rather than break the inbound relay path.
    const stampTz = (() => {
      const configured = process.env.BLUEBUBBLES_TZ
      try {
        if (configured && configured !== '') new Intl.DateTimeFormat('en-GB', { timeZone: configured })
        return configured && configured !== '' ? configured : Intl.DateTimeFormat().resolvedOptions().timeZone
      } catch {
        // unknown/unsupported zone: stay on the host zone
        try {
          return Intl.DateTimeFormat().resolvedOptions().timeZone
        } catch {
          return ''
        }
      }
    })()

    const tzFormatterCache = new Map<string, Intl.DateTimeFormat>()

    function tzFormatter(tz: string): Intl.DateTimeFormat {
      const cached = tzFormatterCache.get(tz)
      if (cached) return cached
      const created = new Intl.DateTimeFormat('en-GB', {
        timeZone: tz,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23',
        timeZoneName: 'shortOffset',
      })
      tzFormatterCache.set(tz, created)
      return created
    }

    // last-resort stamp: host-local wall clock, offset derived from the Date itself
    function localStamp(ms: number): string {
      const d = new Date(ms)
      const p = (n: number) => String(n).padStart(2, '0')
      const offsetMin = -d.getTimezoneOffset()
      const sign = offsetMin < 0 ? '-' : '+'
      const abs = Math.abs(offsetMin)
      const offset = 'UTC' + sign + p(Math.floor(abs / 60)) + ':' + p(abs % 60)
      const stamp = p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes())
      const date = d.getFullYear() === new Date().getFullYear() ? stamp : d.getFullYear() + '-' + stamp
      return date + ' ' + offset
    }

    function fmtStamp(ms: number): string {
      if (stampTz === '') return localStamp(ms)
      try {
        const parts = tzFormatter(stampTz).formatToParts(new Date(ms))
        const get = (t: string) => parts.find((part) => part.type === t)?.value ?? ''
        const tz = get('timeZoneName').replace('GMT', 'UTC')
        const curYear = tzFormatter(stampTz).formatToParts(new Date()).find((p) => p.type === 'year')?.value ?? ''
        const date = (get('year') === curYear ? '' : get('year') + '-') + get('month') + '-' + get('day')
        const hour = get('hour') === '24' ? '00' : get('hour')
        return date + ' ' + hour + ':' + get('minute') + ' ' + tz
      } catch {
        // Intl rejected the zone at format time (small-icu builds, stale tzdata, ...)
        return localStamp(ms)
      }
    }

    // ---- diagnostic breadcrumbs (BLUEBUBBLES_DEBUG=1 writes to $DSH_HOME/bluebubbles-debug.log) ----
    let debugEnabled = process.env.BLUEBUBBLES_DEBUG === '1'
    // serialized write queue: concurrent read-modify-write would lose lines; chained appends keep breadcrumbs intact
    let dbgQueue: Promise<void> = Promise.resolve()
    async function dbg(line: string): Promise<void> {
      if (!debugEnabled || !fs) return
      const write = async (): Promise<void> => {
        try {
          const path = dshHome + '/bluebubbles-debug.log'
          let prev = ''
          try {
            prev = await fs.readText(await fs.resolve(path))
          } catch {
            // missing file = start from empty
          }
          await fs.writeText(await fs.resolve(path), prev + new Date().toISOString() + ' ' + line + '\n')
        } catch {
          // diagnostics must never affect the main flow
        }
      }
      dbgQueue = dbgQueue.then(write)
      await dbgQueue
    }

    async function downloadAttachment(guid: string, name: string, targetDir?: string): Promise<string | null> {
      const dir = targetDir && targetDir !== '' ? targetDir : dshHome + '/bluebubbles-media'
      const safe = (name.replace(/[^\w.\-]+/g, '_').slice(0, 80) || 'attachment')
      const filePath = dir + '/' + guid + '-' + safe
      try {
        await runShell(ctx.shell, ctx.shell.resolve({ command: 'mkdir -p "' + shEscape(dir) + '"', timeoutMs: 8000 }))
        const url = endpoint('attachment/' + encodeURIComponent(guid) + '/download')
        const command = "curl -sS -f -m 60 -o '" + shEscape(filePath) + "' '" + shEscape(url) + "'"
        const spec = ctx.shell.resolve({ command, timeoutMs: 70000, stdoutMaxBytes: 4096 } satisfies ShellExecRequest)
        const run = await runShell(ctx.shell, spec)
        if (run.exitCode !== 0) {
          const detail = ((run.stderr && run.stderr.text) ? run.stderr.text : '').trim()
          console.log('bb: attachment download failed ' + guid + ': ' + (detail || 'exit ' + run.exitCode))
          return null
        }
        return filePath
      } catch (err) {
        console.log('bb: attachment download error ' + guid + ': ' + (err instanceof Error ? err.message : err))
        return null
      }
    }

    // ================= quoted-reply rendering =================
    // iMessage stamps a parent guid (`replyToGuid`) on essentially every message, not
    // only on an explicit swipe-reply, and that default parent is just the previous
    // message of the chat. The pointer alone therefore cannot tell a real quote from
    // the chain, so remember the last message guid per chat and render a quote only
    // when the parent is something else. Tapbacks already carry their quoted text
    // (BlueBubbles renders them as "很疑惑：…"), so they are excluded to avoid doubling
    // the quote. Only ever an extra read per genuine quote: the common chain case
    // short-circuits on the remembered guid.
    const QUOTE_EXCERPT_MAX = 40
    const lastMessageByChat = new Map<string, { guid: string; createdMs: number | null }>()
    // Separate from delivery dedup: a REST send can enter seenGuids before its
    // first webhook echo, which still needs to advance the observed chat history.
    const observedGuids = new Set<string>()

    /** Collapse whitespace and cut to the excerpt length without splitting a surrogate pair. */
    function quoteExcerpt(raw: unknown): string | null {
      if (typeof raw !== 'string') return null
      const flat = raw.replace(/\s+/g, ' ').trim()
      if (flat === '') return null
      const chars = Array.from(flat)
      return chars.length > QUOTE_EXCERPT_MAX ? chars.slice(0, QUOTE_EXCERPT_MAX).join('') + '…' : flat
    }

    async function fetchParentMessage(guid: string): Promise<any | null> {
      try {
        const res = await curl('GET', 'message/' + encodeURIComponent(guid) + '?with=attachments', null)
        if (!res.ok || !res.data || typeof res.data !== 'object') {
          await dbg('quote:parent fetch failed ' + guid + ' (' + (res.error || 'empty response') + ')')
          return null
        }
        return res.data as any
      } catch (err) {
        // Quotes are optional context: shell infrastructure failures must not
        // abort delivery of the incoming message after the webhook was accepted.
        await dbg('quote:parent fetch failed ' + guid + ' (' + (err instanceof Error ? err.message : String(err)) + ')')
        return null
      }
    }

    /** Who sent a message: the relayed account itself, or a resolved display name. */
    function authorLabel(message: Record<string, any>): string {
      if (message.isFromMe === true) return '我'
      const handle = (message.handle && typeof message.handle === 'object') ? message.handle : {}
      const address = typeof handle.address === 'string' && handle.address !== '' ? handle.address : null
      const named = typeof handle.displayName === 'string' && handle.displayName !== '' ? handle.displayName : null
      return named || (address ? state.contacts[address] : null) || address || '对方'
    }

    /** "↪ 引用（作者）：「…」" for a swipe-reply, empty string when there is nothing to quote. */
    async function quotedReplyBlock(m: Record<string, any>, previousGuid: string | undefined): Promise<string> {
      const replyToGuid = typeof m.replyToGuid === 'string' && m.replyToGuid !== '' ? m.replyToGuid : null
      if (!replyToGuid) return ''
      // a tapback is already rendered as "<reaction>：<quoted text>" by the server
      if (m.associatedMessageGuid || m.associatedMessageType) return ''
      // no memory of this chat yet (right after a restart): stay quiet rather than
      // quote the previous message by mistake
      if (previousGuid === undefined) return ''
      if (replyToGuid === previousGuid) return ''
      const parent = await fetchParentMessage(replyToGuid)
      if (!parent) return ''
      const excerpt = quoteExcerpt(parent.text)
        || (Array.isArray(parent.attachments) && parent.attachments.length > 0 ? '（附件）' : null)
      if (!excerpt) return ''
      await dbg('quote rendered for ' + (m.guid || '?') + ' → parent ' + replyToGuid + ' from ' + authorLabel(parent))
      return '↪ 引用（' + authorLabel(parent) + '）：「' + excerpt + '」\n\n'
    }

    async function processEvent(event: { type?: string; data?: any } | null): Promise<void> {
      if (!event || event.type !== 'new-message') return
      const m = event.data || {}
      const text = m.text
      // First webhook observations advance history even for dropped bridge echoes.
      // Duplicate deliveries do not represent new messages. A timestamp older than
      // the newest observation also must not rewind history; suppress its quote
      // because its actual predecessor is unknown to this arrival-order heuristic.
      const chatGuidEarly: string | null = (Array.isArray(m.chats) && m.chats[0] && m.chats[0].guid) || null
      const lastMessage = chatGuidEarly ? lastMessageByChat.get(chatGuidEarly) : undefined
      const messageGuid = typeof m.guid === 'string' && m.guid !== '' ? m.guid : null
      const messageCreatedMs = toUnixMs(m.dateCreated)
      const olderObservation = lastMessage && lastMessage.createdMs !== null && messageCreatedMs !== null
        && messageCreatedMs < lastMessage.createdMs
      const previousGuid = olderObservation ? undefined : lastMessage?.guid
      if (chatGuidEarly && messageGuid && !observedGuids.has(messageGuid)) {
        observedGuids.add(messageGuid)
        if (observedGuids.size > SEEN_GUIDS_MAX) observedGuids.delete(observedGuids.values().next().value!)
        if (!olderObservation) lastMessageByChat.set(chatGuidEarly, { guid: messageGuid, createdMs: messageCreatedMs })
      }
      const attachments: any[] = Array.isArray(m.attachments) ? m.attachments : []
      const hasText = typeof text === 'string' && text.trim() !== ''
      await dbg('event guid=' + (m.guid || '?') + ' isFromMe=' + m.isFromMe + ' sender=' + (m.handle && m.handle.address || '?') + ' tempGuid=' + (m.tempGuid || '?') + ' chats0=' + ((Array.isArray(m.chats) && m.chats[0] && m.chats[0].guid) || '?') + ' text=' + String(text || '').slice(0, 40))
      if (!hasText && attachments.length === 0) { await dbg('drop:empty text&atts'); return }
      if (m.isFromMe) {
        // Messages from our own account: a pendingSent match means this bridge sent
        // it (drop, anti-loop); otherwise the user typed it on the phone/Mac — in a
        // self-chat DM those arrive with isFromMe=true too — so let it through.
        const chat0 = (Array.isArray(m.chats) && m.chats[0]) || null
        if (matchPending(chat0 ? chat0.guid : null, typeof text === 'string' ? text : '')) { await dbg('drop:pendingSent'); return }
        await dbg('note:isFromMe passthrough')
      }
      // Machine-originated sends echo back over the webhook; both prefixes must be
      // dropped or a reply sent via the bb-channel CLI would be re-injected into the
      // bound session as if the user had sent it (self-loop). pendingSent cannot
      // catch CLI sends: that queue only tracks plugin-side tool sends.
      if (m.tempGuid && (String(m.tempGuid).indexOf('dsh-') === 0 || String(m.tempGuid).indexOf('bbcli-') === 0)) { await dbg('drop:tempGuid'); return }
      const guid = typeof m.guid === 'string' ? m.guid : null
      if (guid) {
        if (seenGuids.has(guid)) { await dbg('drop:seenGuid ' + guid); return }
        seenGuids.add(guid)
        if (seenGuids.size > SEEN_GUIDS_MAX) {
          const oldest = seenGuids.values().next()
          if (!oldest.done) seenGuids.delete(oldest.value)
        }
      }

      const chat = (Array.isArray(m.chats) && m.chats[0]) || null
      const chatGuid: string | null = chat ? chat.guid : null
      const sender: string | null = (m.handle && m.handle.address) || null
      const chatName: string = chat ? (chat.displayName || '') : ''

      // Acquire an admission before any async resume/quote/attachment work.
      // Management sets its promise synchronously; admissions then wait for publication.
      if (bindingMutation) await bindingMutation.catch(() => {})
      inboundAdmissions += 1
      try {
      // hot re-read of bindings/contacts before every message (the CLI may have just edited them)
      await reloadStateFiles(false)

      const keys: string[] = []
      if (chatGuid) keys.push('chat:' + chatGuid)
      if (sender) keys.push('addr:' + sender)
      let binding: Binding | null = null
      for (const key of keys) {
        if (state.bindings[key]) {
          binding = state.bindings[key]
          break
        }
      }
      if (!binding) {
        await dbg('drop:no-binding keys=' + JSON.stringify(keys) + ' bindings=' + JSON.stringify(Object.keys(state.bindings)))
        console.log('bb: unbound chat, message ignored (' + (chatName || sender || chatGuid || 'unknown') + ')')
        return
      }

      const sessionId = await resolveSession(workspaces, binding)
      if (!sessionId) {
        await dbg('drop:no-session binding=' + JSON.stringify(binding) + ' wsSvc=' + (workspaces ? 'yes' : 'NO'))
        console.log('bb: binding target has no session: ' + JSON.stringify(binding))
        return
      }
      // resume the persisted session on demand: after a DSH restart no agent
      // is live until the web UI reopens it, which must not mute a bound chat
      const agent = await ensureLiveAgent(ctx, agents, sessionId)
      if (!agent) {
        await dbg('drop:no-agent session=' + sessionId + ' agentsSvc=' + (agents ? 'yes' : 'NO'))
        console.log('bb: target session has no live agent (and resume failed): ' + sessionId)
        return
      }

      // attachments all land in $DSH_HOME/bluebubbles-media (the agent copies them into the workspace when needed)
      const mediaDir = dshHome + '/bluebubbles-media'
      let attachmentBlock = ''
      if (attachments.length > 0) {
        const lines: string[] = []
        const toFetch = attachments.slice(0, 3)
        for (const att of toFetch) {
          if (!att || typeof att.guid !== 'string') continue
          const name = typeof att.transferName === 'string' && att.transferName !== '' ? att.transferName : 'attachment'
          const meta = [att.mimeType, typeof att.totalBytes === 'number' ? fmtBytes(att.totalBytes) : null, att.width && att.height ? att.width + 'x' + att.height : null].filter(Boolean).join(', ')
          const saved = await downloadAttachment(att.guid, name, mediaDir)
          lines.push('- ' + name + (meta ? '（' + meta + '）' : '') + (saved ? ' → 已保存 ' + saved : ' → 下载失败'))
        }
        if (attachments.length > toFetch.length) lines.push('- …另有 ' + (attachments.length - toFetch.length) + ' 个附件')
        attachmentBlock = '\n\n📎 附件：\n' + lines.join('\n')
      }

      // sender display name: payload's own field → local contacts (~/.dsh/bluebubbles-contacts.json) → bare address
      const handleObj = (m.handle && typeof m.handle === 'object') ? m.handle : {}
      const senderName: string | null =
        (typeof handleObj.displayName === 'string' && handleObj.displayName !== '' ? handleObj.displayName : null)
        || (sender && state.contacts[sender]) || null
      const fromPart = sender ? ' · 来自 ' + (senderName ? senderName + '（' + sender + '）' : sender) : ''

      const body = (await quotedReplyBlock(m, previousGuid)) + (hasText ? text : '(无文字内容的消息)') + attachmentBlock
      const createdMs = toUnixMs(m.dateCreated)
      let timePart = ''
      try {
        if (createdMs !== null) timePart = ' · ' + fmtStamp(createdMs)
      } catch {
        timePart = ''
      }
      const line = '📱 iMessage' + timePart + (chatName ? ' · ' + chatName : '') + fromPart + '\n' + body
      // next-step: opens a new turn when idle, merges into the current turn's next step boundary when busy (naturally coalesces bursts)
      if (sendUserMessage(agents, sessionId, line, 'dsh-bluebubbles', 'next-step')) {
        // register the iMessage-triggered turn: typing indicator (default on) and reply auto-delivery (when relay: true)
        if (chatGuid) {
          await setTrigger(sessionId, chatGuid, binding.relay === true, binding.typing !== false, true)
          if (binding.typing !== false) void sendTyping(chatGuid)
        }
        await dbg('delivered session=' + sessionId)
        console.log('bb: message delivered to session ' + sessionId + ' (' + (chatName || sender || chatGuid) + ')')
      }
      } finally { inboundAdmissions -= 1 }
    }

    // ================= iMessage-triggered turn ergonomics (typing indicator + reply auto-delivery) =================
    // Semantics: injecting an iMessage registers a trigger; the session's following
    // turn counts as "replying to that iMessage" — typing shows the peer "typing…";
    // with relay on, every assistant message containing text parts is sent back
    // immediately (via sendText, which self-records for anti-loop; only type==='text'
    // parts ship — thinking/reasoning and tool results are never delivered);
    // turn/end clears the trigger so later unrelated turns never cross-deliver.
    // The trigger table persists to the relay-state file because a hot reload
    // rebuilds the plugin instance mid-turn; a purely in-memory table would lose
    // triggers and silently produce "inbound arrived, reply never relayed".
    // setAt + TTL prevent an ancient trigger from resurrecting into a new turn.
    type RelayTrigger = { chatGuid: string; relay: boolean; typing: boolean; lastTypingAt: number; setAt: number; bindingRequired?: boolean; generation?: number }
    const relayGenerations = new Map<string, number>()
    const RELAY_TRIGGER_TTL_MS = 10 * 60 * 1000
    const inboundTriggers = new Map<string, RelayTrigger>()

    async function persistTriggers(): Promise<void> {
      if (!fs) return
      try {
        const obj: Record<string, RelayTrigger> = {}
        for (const [sessionId, t] of inboundTriggers) obj[sessionId] = { ...t }
        const dir = state.relayStatePath.replace(/\/[^/]*$/, '')
        await runShell(ctx.shell, ctx.shell.resolve({ command: 'mkdir -p "' + shEscape(dir) + '"', timeoutMs: 8000 }))
        const target = await fs.resolve(state.relayStatePath)
        await fs.writeText(target, JSON.stringify(obj, null, 2))
      } catch (err) {
        console.log('bb: relay state write failed (degrading to in-memory): ' + (err instanceof Error ? err.message : err))
      }
    }

    async function loadTriggers(): Promise<void> {
      const raw = await readJsonFile(state.relayStatePath)
      if (!raw) return
      const now = Date.now()
      let loaded = 0
      for (const [sessionId, value] of Object.entries(raw)) {
        // Startup observation may finish after a real inbound has armed a new
        // trigger. Never replace that live ownership with the disk snapshot.
        if (inboundTriggers.has(sessionId)) continue
        if (!value || typeof value !== 'object') continue
        const t = value as Partial<RelayTrigger>
        if (typeof t.chatGuid !== 'string') continue
        if (typeof t.setAt !== 'number' || now - t.setAt > RELAY_TRIGGER_TTL_MS) continue // expired triggers are dropped outright
        inboundTriggers.set(sessionId, {
          bindingRequired: t.bindingRequired !== false,
          generation: (relayGenerations.get(sessionId) || 0) + 1,
          chatGuid: t.chatGuid,
          relay: t.relay !== false,
          typing: t.typing !== false,
          lastTypingAt: 0,
          setAt: t.setAt,
        })
        relayGenerations.set(sessionId, inboundTriggers.get(sessionId)!.generation!)
        loaded += 1
      }
      if (loaded > 0) void dbg('relay triggers loaded=' + loaded)
    }

    async function setTrigger(sessionId: string, chatGuid: string, relay: boolean, typing: boolean, bindingRequired = false): Promise<void> {
      if (bindingMutation) await bindingMutation.catch(() => {})
      inboundTriggers.set(sessionId, {
        bindingRequired,
        generation: (relayGenerations.get(sessionId) || 0) + 1,
        chatGuid,
        relay,
        typing,
        lastTypingAt: 0,
        setAt: Date.now(),
      })
      relayGenerations.set(sessionId, inboundTriggers.get(sessionId)!.generation!)
      await persistTriggers()
    }

    async function clearTrigger(sessionId: string): Promise<void> {
      if (!inboundTriggers.delete(sessionId)) return
      await persistTriggers()
    }

    async function sendTyping(chatGuid: string): Promise<void> {
      try {
        await curl('POST', 'chat/' + encodeURIComponent(chatGuid) + '/typing', {})
      } catch {
        // typing indicator is pure decoration; failures are ignored
      }
    }

    function assistantTextOf(event: { data?: any }): string {
      const message = event.data && event.data.message
      const content = message && Array.isArray(message.content) ? message.content : []
      const texts: string[] = []
      for (const part of content) {
        if (part && part.type === 'text' && typeof part.text === 'string') texts.push(part.text)
      }
      return texts.join('\n').trim()
    }

    ctx.on('session/event', (session: { id?: string }, event: { type?: string; data?: any }) => {
      try {
        const sessionId = session && session.id
        if (!sessionId || !event || typeof event.type !== 'string') return
        const trigger = inboundTriggers.get(sessionId)
        if (!trigger) return
        // Expire idle triggers before a new turn claims them. Once a turn has
        // started, its final response remains deliverable even after ten minutes.
        if (event.type === 'turn/start' && Date.now() - trigger.setAt > RELAY_TRIGGER_TTL_MS) {
          void clearTrigger(sessionId)
          return
        }
        if (event.type === 'turn/start' || event.type === 'step/start') {
          if (!trigger.typing) return
          const now = Date.now()
          if (now - trigger.lastTypingAt < 8000) return // the indicator expires server-side; re-arm throttled to 8s
          trigger.lastTypingAt = now
          void sendTyping(trigger.chatGuid)
          return
        }
        if (event.type === 'assistant/message' && trigger.relay) {
          const text = assistantTextOf(event)
          if (text === '') return // pure tool-call step; wait for later text
          // explicit silence: an exact NO_REPLY reply (after trim) stops delivery for the rest of the turn and clears the trigger at once
          if (text === 'NO_REPLY') {
            void clearTrigger(sessionId)
            void dbg('relay suppressed NO_REPLY session=' + sessionId)
            return
          }
          // every assistant message with text ships immediately (thinking/tool results already filtered by assistantTextOf)
          const send = async () => {
            // A newer trigger must not redirect an already queued assistant event.
            if (trigger.generation !== undefined && relayGenerations.get(sessionId) !== trigger.generation) return
            const dispatch = async () => {
              if (trigger.generation !== undefined && relayGenerations.get(sessionId) !== trigger.generation) return
              const r = await sendText({chatGuid: trigger.chatGuid, text})
              await dbg('relay ' + (r.ok ? 'ok' : 'FAIL'))
            }
            if (trigger.bindingRequired === false) return dispatch() // Explicit scheduler armRelay owns its chat authorization.
            await withBindingsLock(state.bindingsPath, async snapshot => {
              const current = snapshot.bindings['chat:' + trigger.chatGuid]
              if (!current || current.relay !== true || await resolveSession(workspaces, current) !== sessionId) return
              await dispatch()
            })
          }
          const job = relayDispatchTail.then(send, send).catch(() => dbg('relay suppressed: binding changed or store unavailable'))
          relayDispatchTail = job
          pendingRelays.add(job)
          void job.finally(() => pendingRelays.delete(job)).catch(() => {})
          return
        }
        if (event.type === 'turn/end') {
          // An error can follow earlier assistant text. Never let its trigger
          // forward a later unrelated web turn; retries must explicitly re-arm.
          void clearTrigger(sessionId)
        }
      } catch {
        // an event listener must never disturb the session event stream
      }
    })

    // ================= headless guard (auto-answer approvals / block ask_user_question for bound sessions) =================
    // Both interactive seams (the approval card and the ask_user_question card)
    // are answered only by a connected web client; for a session driven purely
    // over iMessage either one parks the turn forever. These prepend listeners
    // run ahead of the web answerers and short-circuit exactly the sessions
    // named by the bindings table — every other session falls through next()
    // to the ordinary web flow. The root walk also covers subagent children of
    // a guarded session: the waterfall targets the child's scope, but a child
    // of an iMessage-driven root has no human answerer either.
    const guardEnabled = (process.env.BLUEBUBBLES_GUARD || '1') !== '0'
    // Approvals exist for sandbox escalations; auto-allowing widens what a
    // chat-driven session may do, so reject is the default and 'allow' is an
    // explicit opt-in for trusted setups.
    const guardApprovalOutcome: 'allowed-once' | 'rejected' =
      (process.env.BLUEBUBBLES_GUARD_APPROVAL || 'reject') === 'allow' ? 'allowed-once' : 'rejected'

    function rootAgentOf(agent: any): any {
      if (!agents) return agent
      try {
        let current = agent
        const seen = new Set<string>()
        for (let depth = 0; depth < 8; depth++) {
          if (agents.roots().includes(current)) return current
          const owner = agents.list().find((candidate: any) => candidate !== current && agents.isOwnedBy(current.id, candidate))
          if (!owner || seen.has(owner.id)) return current
          seen.add(owner.id)
          current = owner
        }
        return current
      } catch {
        return agent
      }
    }

    async function isGuardedAgent(agent: any): Promise<boolean> {
      const root = rootAgentOf(agent)
      const sessionId: string | undefined = root && root.session && root.session.id
      if (!sessionId) return false
      // hot re-read: the CLI may have edited the bindings file since the last inbound message
      await reloadStateFiles(false)
      for (const binding of Object.values(state.bindings)) {
        if (binding.sessionId === sessionId) return true
        if (binding.workspacePath && (await resolveSession(workspaces, binding)) === sessionId) return true
      }
      return false
    }

    if (guardEnabled) {
      ctx.on('tools/pre-execute', async (exec, next): Promise<PreToolDecision> => {
        try {
          if (exec.name !== 'ask_user_question' || !exec.agent) return next()
          if (!(await isGuardedAgent(exec.agent))) return next()
          return {
            kind: 'deny',
            reason:
              'This session is driven over iMessage and has no web UI attached, so interactive question cards can never be answered. ' +
              "Ask the question as plain text in your reply instead — the reply is automatically relayed to the user's iMessage — then end your turn and wait for the answer.",
          }
        } catch {
          return next() // a guard failure must never block ordinary tool calls
        }
      }, { prepend: true })

      ctx.on('approval/request', async (req, next): Promise<ApprovalOutcome> => {
        try {
          if (!req.agent) return next()
          if (!(await isGuardedAgent(req.agent))) return next()
          await dbg('guard approval auto-' + guardApprovalOutcome + ' tool=' + req.toolName + ' session=' + req.agent.session.id)
          return guardApprovalOutcome
        } catch {
          return next() // a guard failure must never swallow the web answerer
        }
      }, { prepend: true })

      console.log('bb: headless guard enabled (ask_user_question denied, approvals auto-' + guardApprovalOutcome + ' for iMessage-bound sessions)')
    }

    // ================= startup bootstrap (with retries: the shell may not be ready early in fiber activation) =================
    const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
    const bootstrapOnce = async (): Promise<void> => {
      // Credential chain: process.env → ~/.dsh/.env → ~/.zshenv.
      // .env is injected by DSH only at process start and hot reload never
      // re-reads it, so parse the files again here to keep credentials across
      // reloads.
      let fileText: string | null = null
      if (state.password === '') {
        fileText = await readEnvFiles(ctx.shell, ['"$HOME/.dsh/.env"', '"$HOME/.zshenv"'])
        if (fileText && state.password === '') {
          const pw = pickEnvValue(fileText, 'BLUEBUBBLES_PASSWORD')
          if (pw) {
            state.password = pw
            if (state.baseUrl === 'http://localhost:1234') {
              const url = pickEnvValue(fileText, 'BLUEBUBBLES_BASE_URL')
              if (url) state.baseUrl = url
            }
          }
        }
        if (!debugEnabled && fileText) debugEnabled = pickEnvValue(fileText, 'BLUEBUBBLES_DEBUG') === '1'
      }
      await reloadStateFiles(true)
      await loadTriggers()
      if (state.password !== '') {
        const wh = await ensureWebhook()
        console.log('bb: credentials ready (' + state.baseUrl + '), webhook registration: ' + JSON.stringify(wh))
      } else {
        console.log('bb: BLUEBUBBLES_PASSWORD not found (env / ~/.dsh/.env / ~/.zshenv); run bb-channel configure to write ~/.dsh/.env')
      }
    }
    const bootstrap = async (): Promise<void> => {
      const maxAttempts = 10
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
          await bootstrapOnce()
          return
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          console.log('bb: bootstrap attempt ' + attempt + '/' + maxAttempts + ' failed: ' + msg)
          if (attempt < maxAttempts) await sleep(3000)
        }
      }
      console.log('bb: bootstrap ultimately failed (after ' + maxAttempts + ' retries); credentials/webhook need manual attention')
    }
    void bootstrap().catch((err: unknown) => {
      console.log('bb: bootstrap error: ' + (err instanceof Error ? err.message : err))
    })

    // ================= tool definitions and registration =================
    const OUTPUT = {
      schema: { type: 'object', additionalProperties: true },
      render(_args: unknown, value: unknown) {
        return [{ type: 'text', text: JSON.stringify(value, null, 2) }]
      },
    }

    function define(options: {
      name: string
      description: string
      parameters: Record<string, unknown>
      execute(args: Record<string, unknown>): Promise<Record<string, unknown>>
    }): ToolDefinition {
      return {
        name: options.name,
        description: options.description,
        parameters: options.parameters as unknown as ToolDefinition['parameters'],
        output: OUTPUT,
        async execute(args: unknown) {
          try {
            return await options.execute((args ?? {}) as Record<string, unknown>)
          } catch (err) {
            return { ok: false, error: String(err instanceof Error && err.message ? err.message : err) }
          }
        },
      } as unknown as ToolDefinition
    }

    // Only "send" survives as model tools — everything else (list chats / read
    // messages / bind / configure / webhook) goes through the bb-channel CLI
    // (invoked via bash). See README and the workspace TOOLS.md.
    const tools: ToolDefinition[] = [
      define({
        name: 'bluebubbles_send_text',
        description: 'Send one iMessage text via BlueBubbles. Find chatGuid with `bb-channel chats` in bash.',
        parameters: {
          type: 'object',
          properties: {
            chatGuid: { type: 'string', description: 'Target chat GUID' },
            text: { type: 'string', description: 'Message text to send' },
            method: { type: 'string', enum: ['apple-script', 'private-api'], description: 'apple-script (default) or private-api' },
          },
          required: ['chatGuid', 'text'],
        },
        execute: async (args) => await sendText(args),
      }),
      define({
        name: 'bluebubbles_send_attachment',
        description: 'Send one iMessage attachment (image/file) via BlueBubbles. filePath must be an absolute path on the Mac running BlueBubbles.',
        parameters: {
          type: 'object',
          properties: {
            chatGuid: { type: 'string', description: 'Target chat GUID' },
            filePath: { type: 'string', description: 'Absolute path of the file on that Mac' },
            name: { type: 'string', description: 'File name the recipient sees (defaults to the last path segment)' },
            method: { type: 'string', enum: ['apple-script', 'private-api'], description: 'private-api (default, more reliable) or apple-script' },
          },
          required: ['chatGuid', 'filePath'],
        },
        execute: async (args) => await sendAttachment(args),
      }),
    ]

    for (const tool of tools) {
      ctx.effect(() => ctx.tools.register(tool), 'tool:' + tool.name)
    }

    // ================= HTTP routes =================
    if (webServer) {
      ctx.effect(() => webServer.register({
        kind: 'exact',
        path: '/bluebubbles/webhook',
        handler: (req, res) => onWebhook(req, res),
      }), 'route:webhook')
    }

    // ================= service for other plugins =================
    const provide = (ctx as unknown as { provide(name: string, value: unknown): unknown }).provide
    provide.call(ctx, 'bluebubbles', {
      configure: (args: Record<string, unknown>) => applyConfig(args),
      ping: () => ping(),
      listChats: (args: Record<string, unknown>) => listChats(args || {}),
      getMessages: (args: Record<string, unknown>) => getMessages(args || {}),
      sendText: (args: Record<string, unknown>) => sendText(args || {}),
      sendAttachment: (args: Record<string, unknown>) => sendAttachment(args || {}),
      getAttachment: (args: { guid: string; name?: string }) => downloadAttachment(args.guid, args.name || 'attachment'),
      bind: async (args: { chatGuid: string; workspacePath?: string; sessionId?: string }) => {
        if (bindingMutation || inboundAdmissions || outgoingChats.size || inboundTriggers.size || pendingRelays.size) throw new BindingError('busy')
        const binding: Binding = args.sessionId ? { sessionId: args.sessionId } : { workspacePath: args.workspacePath }
        const task = updateBindings(state.bindingsPath, undefined, table => {
          const retained = {...table['chat:' + args.chatGuid]}
          for (const key of ['sessionId', 'workspacePath', 'relay', 'typing']) delete retained[key]
          table['chat:' + args.chatGuid] = {...retained, ...binding}
        })
        bindingMutation = task
        try { state.bindings = (await task).bindings } finally { if (bindingMutation === task) bindingMutation = undefined }
      },
      listBindings: () => state.bindings,
      whenRelayIdle: () => Promise.allSettled([...pendingRelays]),
      bindingManagement: {
        list: bindingView,
        sessions: async () => {
          const catalog = getService<{list(request: Record<string, never>, signal: AbortSignal): Promise<{items: ReadonlyArray<{sessionId: string; cwd?: string; origin?: string; running: boolean; agentAvailable: boolean}>}>}>(ctx, 'sessionController')
          if (catalog) return {sessions: (await catalog.list({}, new AbortController().signal)).items.map(row => ({id: row.sessionId, cwd: row.cwd ?? '', available: row.origin !== 'subagent', status: row.running ? 'running' : row.agentAvailable ? 'idle' : 'cold'}))}
          const persistence = getService<SessionPersistenceService>(ctx, 'sessionPersistence')
          if (!persistence) throw new BindingError('not-found')
          return {sessions: (await persistence.list()).map(row => ({id: row.header?.id ?? row.id, status: 'unverified'})).filter(row => typeof row.id === 'string')}
        },
        chats: async (args: {limit?: number; offset?: number} = {}) => {
          const limit = args.limit ?? 50, offset = args.offset ?? 0
          const result = await curl('POST', 'chat/query', {limit, offset, with: ['participants']})
          if (!result.ok) throw new BindingError('chat-unavailable')
          const rows = Array.isArray(result.data) ? result.data : []
          const chats = rows.filter(row => typeof row?.guid === 'string').map(row => ({guid: row.guid, title: typeof row.displayName === 'string' ? row.displayName : '', participants: (Array.isArray(row.participants) ? row.participants : []).map((p: any) => typeof p.displayName === 'string' ? p.displayName : typeof p.address === 'string' ? p.address : '').filter(Boolean)}))
          return {chats, hasMore: rows.length === limit, nextOffset: offset + rows.length}
        },
        bind: (args: {chatGuid: string; sessionId: string; relay: boolean; expectedRevision: string}) => mutateBinding(args, 'bind'),
        unbind: (args: {chatGuid: string; expectedRevision: string}) => mutateBinding(args, 'unbind'),
        updateRelay: (args: {chatGuid: string; relay: boolean; expectedRevision: string}) => mutateBinding(args, 'relay'),
      },
      // Lets dsh-cron and friends reuse the inbound relay mechanism: register a
      // "deliver replies to chatGuid" trigger for a session. Semantics identical
      // to iMessage-inbound turns (per-message text delivery, NO_REPLY
      // suppression, turn/end clear, persisted trigger table + TTL).
      armRelay: (args: { sessionId: string; chatGuid: string; relay?: boolean; typing?: boolean }) =>
        setTrigger(args.sessionId, args.chatGuid, args.relay !== false, args.typing === true),
    })
  },
} satisfies Plugin
