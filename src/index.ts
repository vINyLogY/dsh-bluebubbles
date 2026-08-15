// dsh-bluebubbles — BlueBubbles (iMessage) bridge plugin for DeepSeek Harness.
// Real host-composition plugin (TypeScript, erasable-syntax only): runs in the
// DSH host process under Node >= 23.6 native type stripping, no build step.
//
// Secrets come from BLUEBUBBLES_PASSWORD env or a ~/.zshenv fallback; this
// repository never contains credentials.

import type { Context, Plugin } from '@deepseek-ai/cordis'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { ShellExecRequest, ShellExecSpec, ShellRunResult } from '@deepseek-ai/dsh-shell'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import type { IncomingMessage, ServerResponse } from 'node:http'

import { getService, pickEnvValue, readEnvFiles, resolveSession, sendUserMessage } from './lib.ts'
import type { AgentsService, FsService, WorkspaceRegistryService } from './lib.ts'

interface WebServerService {
  register(route: WebRoute): () => void
}

interface Binding {
  workspacePath?: string
  sessionId?: string
}

export default {
  inject: ['tools', 'shell'],
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
    }

    // ================= HTTP 辅助（经 shell 跑 curl：web 服务只支持 GET） =================
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
        return { ok: false, error: 'curl 退出码 ' + run.exitCode + (run.timedOut ? '（超时）' : '') + (detail ? '：' + detail.slice(0, 300) : '') }
      }
      let parsed: any = null
      try {
        parsed = JSON.parse((run.stdout && run.stdout.text) || '')
      } catch {
        return { ok: false, error: '无法解析 BlueBubbles 响应：' + ((run.stdout && run.stdout.text) || '').slice(0, 300) }
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
        // --form-string：值按字面传递，chatGuid 里的 ';' '+' 不会被 curl 的 -F 语法吞掉
        parts.push("--form-string '" + shEscape(key + '=' + value) + "'")
      }
      parts.push("-F 'attachment=@" + shEscape(filePath) + ";filename=" + shEscape(fileName) + "'")
      parts.push("'" + shEscape(url) + "'")
      const command = parts.join(' ')
      const spec: ShellExecSpec = ctx.shell.resolve({ command, timeoutMs: 70000, stdoutMaxBytes: 262144 } satisfies ShellExecRequest)
      const run: ShellRunResult = await ctx.shell.run(spec)
      if (run.exitCode !== 0) {
        const detail = ((run.stderr && run.stderr.text) ? run.stderr.text : (run.stdout ? run.stdout.text : '')).trim()
        return { ok: false, error: 'curl 退出码 ' + run.exitCode + (run.timedOut ? '（超时）' : '') + (detail ? '：' + detail.slice(0, 300) : '') }
      }
      let parsed: any = null
      try {
        parsed = JSON.parse((run.stdout && run.stdout.text) || '')
      } catch {
        return { ok: false, error: '无法解析 BlueBubbles 响应：' + ((run.stdout && run.stdout.text) || '').slice(0, 300) }
      }
      if (parsed && typeof parsed.status === 'number' && parsed.status >= 400) {
        const detail = parsed.error ? (parsed.error.message || parsed.error.error || parsed.error.type || JSON.stringify(parsed.error)) : (parsed.message || 'HTTP ' + parsed.status)
        return { ok: false, error: detail }
      }
      const hasData = parsed && Object.prototype.hasOwnProperty.call(parsed, 'data')
      return { ok: true, data: hasData ? parsed.data : parsed }
    }

    // ================= 精简序列化 =================
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

    // ================= 业务函数 =================
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
      const result = await curl('POST', 'message/text', {
        chatGuid: String(args.chatGuid),
        tempGuid,
        message: String(args.text),
        method,
      })
      if (!result.ok) return result
      return { ok: true, tempGuid, guid: result.data && (result.data as any).guid ? (result.data as any).guid : null, text: result.data && (result.data as any).text ? (result.data as any).text : null }
    }

    async function sendAttachment(args: Record<string, unknown>): Promise<Record<string, unknown>> {
      const filePath = String(args.filePath)
      const tempGuid = 'dsh-' + Date.now().toString(36) + '-' + Math.floor(Math.random() * 1e9).toString(36)
      const name = typeof args.name === 'string' && args.name.trim() !== '' ? args.name.trim() : (filePath.split('/').pop() || 'attachment')
      const method = args.method === 'apple-script' ? 'apple-script' : 'private-api'
      const result = await curlMultipart('message/attachment', {
        chatGuid: String(args.chatGuid),
        tempGuid,
        method,
        name,
      }, filePath, name)
      if (!result.ok) return result
      return { ok: true, tempGuid, name, guid: result.data && (result.data as any).guid ? (result.data as any).guid : null }
    }

    // ================= 绑定表持久化 =================
    async function loadBindings(): Promise<void> {
      if (!fs) return
      try {
        const target = await fs.resolve(state.bindingsPath)
        const text = await fs.readText(target)
        const parsed: unknown = JSON.parse(text)
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          state.bindings = parsed as Record<string, Binding>
          console.log('bb: 已载入绑定表（' + Object.keys(parsed).length + ' 条）')
        }
      } catch (err) {
        console.log('bb: 绑定表载入跳过：' + (err instanceof Error ? err.message : err))
      }
    }

    async function saveBindings(): Promise<void> {
      if (!fs) return
      try {
        // shell 执行器会丢弃环境里的 DSH_* 托管变量，这里用 JS 侧算好的目录
        const dir = state.bindingsPath.replace(/\/[^/]*$/, '')
        await ctx.shell.run(ctx.shell.resolve({ command: 'mkdir -p "' + shEscape(dir) + '"', timeoutMs: 8000 }))
        const target = await fs.resolve(state.bindingsPath)
        await fs.writeText(target, JSON.stringify(state.bindings, null, 2))
      } catch (err) {
        console.log('bb: 绑定表写盘失败（降级为内存态）：' + (err instanceof Error ? err.message : err))
      }
    }

    // ================= webhook：BlueBubbles 自注册 =================
    const WEBHOOK_URL = 'http://127.0.0.1:3080/bluebubbles/webhook'

    async function ensureWebhook(): Promise<Record<string, unknown>> {
      if (!webServer) return { ok: false, registered: false, error: 'webServer 服务不可用，无法接收推送' }
      if (state.password === '') return { ok: false, registered: false, error: '尚未配置 BlueBubbles 密码' }
      // 幂等：先查后建，不依赖服务端对重复 URL 的去重行为
      const list = await curl('GET', 'webhook', null)
      const existing = list.ok && Array.isArray(list.data) ? list.data.find((w: any) => w && w.url === WEBHOOK_URL) : null
      if (existing) return { ok: true, registered: true, id: existing.id, url: WEBHOOK_URL, note: '已存在' }
      const created = await curl('POST', 'webhook', { url: WEBHOOK_URL, events: ['new-message'] })
      if (created.ok) {
        const data = created.data as any
        return { ok: true, registered: true, id: data && data.id ? data.id : null, url: WEBHOOK_URL }
      }
      return { ok: false, registered: false, error: created.error }
    }

    // ================= webhook 事件处理（含消息级去重） =================
    const seenGuids = new Set<string>()
    const SEEN_GUIDS_MAX = 500
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
      res.end('ok-v20')
      let event: { type?: string; data?: any } | null = null
      try {
        event = JSON.parse(raw)
      } catch {
        return
      }
      processEvent(event).catch((err) => console.log('bb: 处理 webhook 事件失败：' + (err instanceof Error ? err.message : err)))
    }

    // ================= 附件下载（收图片） =================
    function fmtBytes(n: number): string {
      if (n >= 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + 'MB'
      if (n >= 1024) return Math.round(n / 1024) + 'KB'
      return n + 'B'
    }

    // ---- 诊断面包屑（BLUEBUBBLES_DEBUG=1 时写入 $DSH_HOME/bluebubbles-debug.log）----
    let debugEnabled = process.env.BLUEBUBBLES_DEBUG === '1'
    async function dbg(line: string): Promise<void> {
      if (!debugEnabled || !fs) return
      try {
        const path = dshHome + '/bluebubbles-debug.log'
        let prev = ''
        try {
          prev = await fs.readText(await fs.resolve(path))
        } catch {
          // 文件不存在 = 从空开始
        }
        await fs.writeText(await fs.resolve(path), prev + new Date().toISOString() + ' ' + line + '\n')
      } catch {
        // 诊断失败不影响主流程
      }
    }

    async function downloadAttachment(guid: string, name: string, targetDir?: string): Promise<string | null> {      const dir = targetDir && targetDir !== '' ? targetDir : dshHome + '/bluebubbles-media'
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
          console.log('bb: 附件下载失败 ' + guid + '：' + (detail || 'exit ' + run.exitCode))
          return null
        }
        return filePath
      } catch (err) {
        console.log('bb: 附件下载异常 ' + guid + '：' + (err instanceof Error ? err.message : err))
        return null
      }
    }

    async function processEvent(event: { type?: string; data?: any } | null): Promise<void> {
      if (!event || event.type !== 'new-message') return
      const m = event.data || {}
      const text = m.text
      const attachments: any[] = Array.isArray(m.attachments) ? m.attachments : []
      const hasText = typeof text === 'string' && text.trim() !== ''
      if (!hasText && attachments.length === 0) { await dbg('drop:empty text&atts'); return }
      if (m.isFromMe) { await dbg('drop:isFromMe'); return }
      if (m.tempGuid && String(m.tempGuid).indexOf('dsh-') === 0) { await dbg('drop:tempGuid'); return }
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
        console.log('bb: 未绑定会话，忽略消息（' + (chatName || sender || chatGuid || '未知') + '）')
        return
      }

      const sessionId = await resolveSession(workspaces, binding)
      if (!sessionId) {
        await dbg('drop:no-session binding=' + JSON.stringify(binding) + ' wsSvc=' + (workspaces ? 'yes' : 'NO'))
        console.log('bb: 绑定目标无会话：' + JSON.stringify(binding))
        return
      }
      const agent = agents ? agents.get(sessionId) : undefined
      if (!agent) {
        await dbg('drop:no-agent session=' + sessionId + ' agentsSvc=' + (agents ? 'yes' : 'NO'))
        console.log('bb: 目标会话无活跃 agent：' + sessionId)
        return
      }

      // 附件：统一存 $DSH_HOME/bluebubbles-media（agent 需要时自行复制进工作区）
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

      const body = (hasText ? text : '(无文字内容的消息)') + attachmentBlock
      const line = '📱 iMessage' + (chatName ? ' · ' + chatName : '') + (sender ? ' · 来自 ' + sender : '') + '\n' + body
      // next-step：空闲时开新回合；忙碌时并入当前回合下一步骤边界（天然合并突发）
      if (sendUserMessage(agents, sessionId, line, 'dsh-bluebubbles', 'next-step')) {
        await dbg('delivered session=' + sessionId)
        console.log('bb: 已投递消息到会话 ' + sessionId + '（' + (chatName || sender || chatGuid) + '）')
      }
    }

    // ================= 启动引导（一次性，无订阅可清理） =================
    const bootstrap = async () => {
      // 凭据链：process.env → ~/.dsh/.env → ~/.zshenv。
      // 注意 .env 只在进程启动时由 DSH 注入，热重载不会重读；
      // 这里自己再解析一遍，保证热重载后凭据不丢。
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
      await loadBindings()
      if (state.password !== '') {
        const wh = await ensureWebhook()
        console.log('bb: 凭据就绪（' + state.baseUrl + '），webhook 注册：' + JSON.stringify(wh))
      } else {
        console.log('bb: 未找到 BLUEBUBBLES_PASSWORD（env / ~/.dsh/.env / ~/.zshenv），等待 bluebubbles_configure')
      }
    }
    void bootstrap()

    // ================= 工具定义与注册 =================
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

    const tools: ToolDefinition[] = [
      define({
        name: 'bluebubbles_configure',
        description: '配置本地 BlueBubbles 服务器连接（base URL 与密码）。默认 baseUrl 为 http://localhost:1234。',
        parameters: {
          type: 'object',
          properties: {
            baseUrl: { type: 'string', description: 'BlueBubbles 服务器地址，例如 http://192.168.1.10:1234' },
            password: { type: 'string', description: 'BlueBubbles 服务器设置中的 Server Password' },
          },
        },
        execute: async (args) => {
          const applied = applyConfig(args)
          const check = await ping()
          const webhook = check.ok ? await ensureWebhook() : null
          return { ok: true, baseUrl: applied.baseUrl, hasPassword: applied.hasPassword, connection: check, webhook }
        },
      }),
      define({
        name: 'bluebubbles_ping',
        description: '检查与已配置 BlueBubbles 服务器的连通性和鉴权。',
        parameters: { type: 'object', properties: {} },
        execute: async () => await ping(),
      }),
      define({
        name: 'bluebubbles_list_chats',
        description: '列出 BlueBubbles 上的 iMessage 会话（含显示名、参与者、最后一条消息），返回每个会话的 chatGuid。',
        parameters: {
          type: 'object',
          properties: {
            limit: { type: 'integer', description: '最多返回的会话数（默认 50，上限 100）' },
          },
        },
        execute: async (args) => await listChats(args),
      }),
      define({
        name: 'bluebubbles_get_messages',
        description: '读取某个 iMessage 会话的最近消息（按时间倒序）。chatGuid 来自 bluebubbles_list_chats。',
        parameters: {
          type: 'object',
          properties: {
            chatGuid: { type: 'string', description: '会话 GUID（来自 bluebubbles_list_chats）' },
            limit: { type: 'integer', description: '最多返回的消息数（默认 25，上限 100）' },
          },
          required: ['chatGuid'],
        },
        execute: async (args) => await getMessages(args),
      }),
      define({
        name: 'bluebubbles_send_text',
        description: '通过 BlueBubbles 发送一条 iMessage 文本消息。chatGuid 来自 bluebubbles_list_chats。',
        parameters: {
          type: 'object',
          properties: {
            chatGuid: { type: 'string', description: '目标会话 GUID' },
            text: { type: 'string', description: '要发送的消息文本' },
            method: { type: 'string', enum: ['apple-script', 'private-api'], description: 'apple-script（默认）或 private-api' },
          },
          required: ['chatGuid', 'text'],
        },
        execute: async (args) => await sendText(args),
      }),
      define({
        name: 'bluebubbles_send_attachment',
        description: '通过 BlueBubbles 发送一条 iMessage 附件消息（图片/文件）。filePath 必须是运行 BlueBubbles 的 Mac 上的绝对路径。',
        parameters: {
          type: 'object',
          properties: {
            chatGuid: { type: 'string', description: '目标会话 GUID' },
            filePath: { type: 'string', description: 'Mac 上要发送的文件的绝对路径' },
            name: { type: 'string', description: '对方看到的文件名（默认取路径最后一段）' },
            method: { type: 'string', enum: ['apple-script', 'private-api'], description: 'private-api（默认，更可靠）或 apple-script' },
          },
          required: ['chatGuid', 'filePath'],
        },
        execute: async (args) => await sendAttachment(args),
      }),
      define({
        name: 'bluebubbles_get_attachment',
        description: '按附件 GUID 下载 iMessage 附件（图片/文件）到指定目录（默认 $DSH_HOME/bluebubbles-media/）并返回本地路径。',
        parameters: {
          type: 'object',
          properties: {
            guid: { type: 'string', description: '附件 GUID（来自消息里的 attachments[].guid）' },
            name: { type: 'string', description: '保存时使用的文件名（默认 attachment）' },
            dir: { type: 'string', description: '目标目录（默认 $DSH_HOME/bluebubbles-media/）' },
          },
          required: ['guid'],
        },
        execute: async (args) => {
          const guid = String(args.guid)
          const name = typeof args.name === 'string' && args.name !== '' ? args.name : 'attachment'
          const dir = typeof args.dir === 'string' && args.dir !== '' ? args.dir : undefined
          const path = await downloadAttachment(guid, name, dir)
          if (!path) return { ok: false, error: '下载失败（见日志）' }
          return { ok: true, guid, path }
        },
      }),
      define({
        name: 'bluebubbles_bind',
        description: '把 iMessage 会话绑定到 DSH 工作区或会话：新消息将通过 webhook 投递为目标会话的用户消息。workspacePath 与 sessionId 二选一（sessionId 更精确，workspacePath 解析到该工作区最新的会话）。',
        parameters: {
          type: 'object',
          properties: {
            chatGuid: { type: 'string', description: '会话 GUID（来自 bluebubbles_list_chats）' },
            workspacePath: { type: 'string', description: '目标 DSH 工作区的目录路径（与 sessionId 二选一）' },
            sessionId: { type: 'string', description: '目标 DSH 会话 ID（与 workspacePath 二选一，优先）' },
          },
          required: ['chatGuid'],
        },
        execute: async (args) => {
          const workspacePath = typeof args.workspacePath === 'string' && args.workspacePath.trim() !== '' ? args.workspacePath.trim() : null
          const sessionId = typeof args.sessionId === 'string' && args.sessionId.trim() !== '' ? args.sessionId.trim() : null
          if (!workspacePath && !sessionId) return { ok: false, error: 'workspacePath 与 sessionId 至少提供一个' }
          const key = 'chat:' + String(args.chatGuid)
          state.bindings[key] = sessionId ? { sessionId } : { workspacePath: workspacePath as string }
          await saveBindings()
          return { ok: true, key, binding: state.bindings[key], total: Object.keys(state.bindings).length }
        },
      }),
      define({
        name: 'bluebubbles_unbind',
        description: '解除 iMessage 会话与工作区的绑定。',
        parameters: {
          type: 'object',
          properties: {
            chatGuid: { type: 'string', description: '会话 GUID' },
          },
          required: ['chatGuid'],
        },
        execute: async (args) => {
          const key = 'chat:' + String(args.chatGuid)
          const existed = Object.prototype.hasOwnProperty.call(state.bindings, key)
          delete state.bindings[key]
          await saveBindings()
          return { ok: true, removed: existed, total: Object.keys(state.bindings).length }
        },
      }),
      define({
        name: 'bluebubbles_list_bindings',
        description: '查看当前 iMessage 会话到 DSH 工作区的绑定表。',
        parameters: { type: 'object', properties: {} },
        execute: async () => ({ ok: true, bindings: state.bindings, bindingsPath: state.bindingsPath }),
      }),
      define({
        name: 'bluebubbles_webhook_status',
        description: '查看并（如缺失）自动注册 BlueBubbles → DSH 的新消息 webhook。',
        parameters: { type: 'object', properties: {} },
        execute: async () => await ensureWebhook(),
      }),
    ]

    for (const tool of tools) {
      ctx.effect(() => ctx.tools.register(tool), 'tool:' + tool.name)
    }

    // ================= HTTP 路由 =================
    if (webServer) {
      ctx.effect(() => webServer.register({
        kind: 'exact',
        path: '/bluebubbles/webhook',
        handler: (req, res) => onWebhook(req, res),
      }), 'route:webhook')
    }

    // ================= 供其它插件使用的服务 =================
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
    })
  },
} satisfies Plugin
