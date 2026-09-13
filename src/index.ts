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

import { ensureLiveAgent, getService, pickEnvValue, readEnvFiles, resolveSession, sendUserMessage } from './lib.ts'
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
      const run: ShellRunResult = await ctx.shell.run(spec)
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
      const run: ShellRunResult = await ctx.shell.run(spec)
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
    }

    async function sendAttachment(args: Record<string, unknown>): Promise<Record<string, unknown>> {
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

    async function saveBindings(): Promise<void> {
      if (!fs) return
      try {
        // the shell executor strips managed DSH_* env vars, so derive the directory JS-side
        const dir = state.bindingsPath.replace(/\/[^/]*$/, '')
        await ctx.shell.run(ctx.shell.resolve({ command: 'mkdir -p "' + shEscape(dir) + '"', timeoutMs: 8000 }))
        const target = await fs.resolve(state.bindingsPath)
        await fs.writeText(target, JSON.stringify(state.bindings, null, 2))
      } catch (err) {
        console.log('bb: bindings write failed (degrading to in-memory): ' + (err instanceof Error ? err.message : err))
      }
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
        await ctx.shell.run(ctx.shell.resolve({ command: 'mkdir -p "' + shEscape(dir) + '"', timeoutMs: 8000 }))
        const url = endpoint('attachment/' + encodeURIComponent(guid) + '/download')
        const command = "curl -sS -f -m 60 -o '" + shEscape(filePath) + "' '" + shEscape(url) + "'"
        const spec = ctx.shell.resolve({ command, timeoutMs: 70000, stdoutMaxBytes: 4096 } satisfies ShellExecRequest)
        const run = await ctx.shell.run(spec)
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

    async function processEvent(event: { type?: string; data?: any } | null): Promise<void> {
      if (!event || event.type !== 'new-message') return
      const m = event.data || {}
      const text = m.text
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

      const body = (hasText ? text : '(无文字内容的消息)') + attachmentBlock
      const line = '📱 iMessage' + (chatName ? ' · ' + chatName : '') + fromPart + '\n' + body
      // next-step: opens a new turn when idle, merges into the current turn's next step boundary when busy (naturally coalesces bursts)
      if (sendUserMessage(agents, sessionId, line, 'dsh-bluebubbles', 'next-step')) {
        // register the iMessage-triggered turn: typing indicator (default on) and reply auto-delivery (when relay: true)
        if (chatGuid) {
          await setTrigger(sessionId, chatGuid, binding.relay === true, binding.typing !== false)
          if (binding.typing !== false) void sendTyping(chatGuid)
        }
        await dbg('delivered session=' + sessionId)
        console.log('bb: message delivered to session ' + sessionId + ' (' + (chatName || sender || chatGuid) + ')')
      }
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
    type RelayTrigger = { chatGuid: string; relay: boolean; typing: boolean; lastTypingAt: number; setAt: number }
    const RELAY_TRIGGER_TTL_MS = 10 * 60 * 1000
    const inboundTriggers = new Map<string, RelayTrigger>()

    async function persistTriggers(): Promise<void> {
      if (!fs) return
      try {
        const obj: Record<string, RelayTrigger> = {}
        for (const [sessionId, t] of inboundTriggers) obj[sessionId] = { ...t }
        const dir = state.relayStatePath.replace(/\/[^/]*$/, '')
        await ctx.shell.run(ctx.shell.resolve({ command: 'mkdir -p "' + shEscape(dir) + '"', timeoutMs: 8000 }))
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
        if (!value || typeof value !== 'object') continue
        const t = value as Partial<RelayTrigger>
        if (typeof t.chatGuid !== 'string') continue
        if (typeof t.setAt !== 'number' || now - t.setAt > RELAY_TRIGGER_TTL_MS) continue // expired triggers are dropped outright
        inboundTriggers.set(sessionId, {
          chatGuid: t.chatGuid,
          relay: t.relay !== false,
          typing: t.typing !== false,
          lastTypingAt: 0,
          setAt: t.setAt,
        })
        loaded += 1
      }
      if (loaded > 0) void dbg('relay triggers loaded=' + loaded)
    }

    async function setTrigger(sessionId: string, chatGuid: string, relay: boolean, typing: boolean): Promise<void> {
      inboundTriggers.set(sessionId, {
        chatGuid,
        relay,
        typing,
        lastTypingAt: 0,
        setAt: Date.now(),
      })
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
          void sendText({ chatGuid: trigger.chatGuid, text }).then((r) => dbg('relay ' + (r.ok ? 'ok' : 'FAIL ' + JSON.stringify(r).slice(0, 120))))
          return
        }
        if (event.type === 'turn/end') void clearTrigger(sessionId)
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
      bind: (args: { chatGuid: string; workspacePath?: string; sessionId?: string }) => {
        const binding: Binding = args.sessionId ? { sessionId: args.sessionId } : { workspacePath: args.workspacePath }
        state.bindings['chat:' + args.chatGuid] = binding
        return saveBindings()
      },
      listBindings: () => state.bindings,
      // Lets dsh-cron and friends reuse the inbound relay mechanism: register a
      // "deliver replies to chatGuid" trigger for a session. Semantics identical
      // to iMessage-inbound turns (per-message text delivery, NO_REPLY
      // suppression, turn/end clear, persisted trigger table + TTL).
      armRelay: (args: { sessionId: string; chatGuid: string; relay?: boolean; typing?: boolean }) =>
        setTrigger(args.sessionId, args.chatGuid, args.relay !== false, args.typing === true),
    })
  },
} satisfies Plugin
