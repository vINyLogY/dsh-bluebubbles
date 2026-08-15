// dsh-bluebubbles — BlueBubbles (iMessage) bridge plugin for DeepSeek Harness.
// Real host-composition plugin (plain ESM, no sandbox): runs in the DSH host
// process with the standard Cordis service surface.
//
// Secrets come from BLUEBUBBLES_PASSWORD env or a ~/.zshenv fallback; this
// repository never contains credentials.

export default {
  inject: ['tools', 'shell'],
  apply(ctx) {
    // ---- optional services (graceful degradation) ----
    const webServer = ctx.get('webServer')
    const agents = ctx.get('agents')
    const fs = ctx.get('fs')
    const workspaces = ctx.get('workspaceRegistry')

    // ---- state ----
    const state = {
      baseUrl: (process.env.BLUEBUBBLES_BASE_URL || 'http://localhost:1234'),
      password: (process.env.BLUEBUBBLES_PASSWORD || ''),
      bindings: {}, // 'chat:<guid>' | 'addr:<address>' -> { workspacePath?, sessionId? }
      bindingsPath: (process.env.BLUEBUBBLES_BINDINGS || process.env.HOME + '/.dsh/bluebubbles-bindings.json'),
    }

    // ================= HTTP 辅助（经 shell 跑 curl：web 服务只支持 GET） =================
    function base() {
      return state.baseUrl.replace(/\/+$/, '')
    }

    function endpoint(path) {
      const sep = path.indexOf('?') === -1 ? '?' : '&'
      return base() + '/api/v1/' + path + sep + 'password=' + encodeURIComponent(state.password)
    }

    function shEscape(value) {
      return String(value).replace(/'/g, "'\\''")
    }

    async function curl(method, path, body) {
      const url = endpoint(path)
      let command
      if (body === null || body === undefined) {
        command = "curl -sS -m 20 '" + shEscape(url) + "'"
      } else {
        const json = JSON.stringify(body).replace(/'/g, "'\\''")
        command = "curl -sS -m 30 -X " + method + " -H 'Content-Type: application/json' --data-raw '" + json + "' '" + shEscape(url) + "'"
      }
      const spec = ctx.shell.resolve({ command, timeoutMs: 35000, stdoutMaxBytes: 262144 })
      const run = await ctx.shell.run(spec)
      if (run.exitCode !== 0) {
        const detail = ((run.stderr && run.stderr.text) ? run.stderr.text : (run.stdout ? run.stdout.text : '')).trim()
        return { ok: false, error: 'curl 退出码 ' + run.exitCode + (run.timedOut ? '（超时）' : '') + (detail ? '：' + detail.slice(0, 300) : '') }
      }
      let parsed = null
      try {
        parsed = JSON.parse((run.stdout && run.stdout.text) || '')
      } catch (err) {
        return { ok: false, error: '无法解析 BlueBubbles 响应：' + ((run.stdout && run.stdout.text) || '').slice(0, 300) }
      }
      if (parsed && typeof parsed.status === 'number' && parsed.status >= 400) {
        const detail = parsed.error ? (parsed.error.error || parsed.error.type || JSON.stringify(parsed.error)) : (parsed.message || 'HTTP ' + parsed.status)
        return { ok: false, error: detail }
      }
      const hasData = parsed && Object.prototype.hasOwnProperty.call(parsed, 'data')
      return { ok: true, data: hasData ? parsed.data : parsed }
    }

    // ================= 精简序列化 =================
    function compactMessage(m) {
      return {
        guid: m.guid,
        text: m.text,
        isFromMe: !!m.isFromMe,
        dateCreated: m.dateCreated ?? null,
        dateRead: m.dateRead ?? null,
        itemType: m.itemType ?? null,
      }
    }

    function compactChat(c) {
      return {
        guid: c.guid,
        displayName: c.displayName,
        style: c.style,
        chatIdentifier: c.chatIdentifier,
        participants: Array.isArray(c.participants) ? c.participants.map((p) => p.address) : [],
        lastMessage: c.lastMessage ? compactMessage(c.lastMessage) : null,
      }
    }

    // ================= 业务函数 =================
    async function ping() {
      const started = Date.now()
      const result = await curl('GET', 'ping', null)
      if (!result.ok) return result
      return { ok: true, latencyMs: Date.now() - started, server: result.data }
    }

    function applyConfig(args) {
      if (args && typeof args.baseUrl === 'string' && args.baseUrl.trim() !== '') state.baseUrl = args.baseUrl.trim()
      if (args && typeof args.password === 'string' && args.password !== '') state.password = args.password
      return { baseUrl: state.baseUrl, hasPassword: state.password !== '' }
    }

    async function listChats(args) {
      const limit = typeof args.limit === 'number' ? Math.min(Math.max(Math.floor(args.limit), 1), 100) : 50
      const result = await curl('POST', 'chat/query', { limit, offset: 0, sort: 'lastmessage', with: ['lastmessage', 'participants'] })
      if (!result.ok) return result
      const chats = Array.isArray(result.data) ? result.data : []
      return { ok: true, total: chats.length, chats: chats.map(compactChat) }
    }

    async function getMessages(args) {
      const guid = String(args.chatGuid)
      const limit = typeof args.limit === 'number' ? Math.min(Math.max(Math.floor(args.limit), 1), 100) : 25
      const result = await curl('GET', 'chat/' + encodeURIComponent(guid) + '/message?limit=' + limit + '&sort=DESC', null)
      if (!result.ok) return result
      const messages = Array.isArray(result.data) ? result.data : []
      return { ok: true, count: messages.length, messages: messages.map(compactMessage) }
    }

    async function sendText(args) {
      const tempGuid = 'dsh-' + Date.now().toString(36) + '-' + Math.floor(Math.random() * 1e9).toString(36)
      const method = args.method === 'private-api' ? 'private-api' : 'apple-script'
      const result = await curl('POST', 'message/text', {
        chatGuid: String(args.chatGuid),
        tempGuid,
        message: String(args.text),
        method,
      })
      if (!result.ok) return result
      return { ok: true, tempGuid, guid: result.data && result.data.guid ? result.data.guid : null, text: result.data && result.data.text ? result.data.text : null }
    }

    // ================= 绑定表持久化 =================
    async function loadBindings() {
      if (!fs) return
      try {
        const target = await fs.resolve(state.bindingsPath)
        const text = await fs.readText(target)
        const parsed = JSON.parse(text)
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          state.bindings = parsed
          console.log('bb: 已载入绑定表（' + Object.keys(parsed).length + ' 条）')
        }
      } catch (err) {
        // 文件不存在 = 空表；解析失败仅告警
        console.log('bb: 绑定表载入跳过：' + (err && err.message ? err.message : err))
      }
    }

    async function saveBindings() {
      if (!fs) return
      try {
        await ctx.shell.run(ctx.shell.resolve({ command: 'mkdir -p "$HOME/.dsh"', timeoutMs: 8000 }))
        const target = await fs.resolve(state.bindingsPath)
        await fs.writeText(target, JSON.stringify(state.bindings, null, 2))
      } catch (err) {
        console.log('bb: 绑定表写盘失败（降级为内存态）：' + (err && err.message ? err.message : err))
      }
    }

    // ================= webhook：BlueBubbles 自注册 =================
    const WEBHOOK_URL = 'http://127.0.0.1:3080/bluebubbles/webhook'

    async function ensureWebhook() {
      if (!webServer) return { ok: false, registered: false, error: 'webServer 服务不可用，无法接收推送' }
      if (state.password === '') return { ok: false, registered: false, error: '尚未配置 BlueBubbles 密码' }
      const created = await curl('POST', 'webhook', { url: WEBHOOK_URL, events: ['new-message'] })
      if (created.ok) {
        return { ok: true, registered: true, id: created.data && created.data.id ? created.data.id : null, url: WEBHOOK_URL }
      }
      // 可能已存在（重复创建报错），查列表确认
      const list = await curl('GET', 'webhook', null)
      const found = list.ok && Array.isArray(list.data) ? list.data.find((w) => w && w.url === WEBHOOK_URL) : null
      if (found) return { ok: true, registered: true, id: found.id, url: WEBHOOK_URL, note: '已存在' }
      return { ok: false, registered: false, error: created.error }
    }

    // ================= webhook：HTTP 路由 =================
    function readBody(req) {
      return new Promise((resolve, reject) => {
        let size = 0
        const chunks = []
        req.on('data', (chunk) => {
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

    async function onWebhook(req, res) {
      const remote = (req.socket && req.socket.remoteAddress) || ''
      const loopback = remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1'
      if (!loopback) {
        res.statusCode = 403
        res.end('forbidden')
        return
      }
      let raw
      try {
        raw = await readBody(req)
      } catch (err) {
        if (!res.headersSent) {
          res.statusCode = 400
          res.end('bad request')
        }
        return
      }
      res.statusCode = 200
      res.end('ok')
      let event = null
      try {
        event = JSON.parse(raw)
      } catch (err) {
        return
      }
      processEvent(event).catch((err) => console.log('bb: 处理 webhook 事件失败：' + (err && err.message ? err.message : err)))
    }

    async function resolveSessionFor(binding) {
      if (binding && binding.sessionId) return binding.sessionId
      if (!binding || !binding.workspacePath || !workspaces) return null
      try {
        const ws = await workspaces.resolveByPath(binding.workspacePath)
        if (ws && Array.isArray(ws.sessionIds) && ws.sessionIds.length > 0) return ws.sessionIds[0]
      } catch (err) {
        console.log('bb: 解析工作区失败：' + (err && err.message ? err.message : err))
      }
      return null
    }

    async function processEvent(event) {
      if (!event || event.type !== 'new-message') return
      const m = event.data || {}
      const text = m.text
      if (typeof text !== 'string' || text.trim() === '') return
      if (m.isFromMe) return
      if (m.tempGuid && String(m.tempGuid).indexOf('dsh-') === 0) return

      const chat = (Array.isArray(m.chats) && m.chats[0]) || null
      const chatGuid = chat ? chat.guid : null
      const sender = (m.handle && m.handle.address) || null
      const chatName = chat ? (chat.displayName || '') : ''

      const keys = []
      if (chatGuid) keys.push('chat:' + chatGuid)
      if (sender) keys.push('addr:' + sender)
      let binding = null
      for (const key of keys) {
        if (state.bindings[key]) {
          binding = state.bindings[key]
          break
        }
      }
      if (!binding) {
        console.log('bb: 未绑定会话，忽略消息（' + (chatName || sender || chatGuid || '未知') + '）')
        return
      }

      const sessionId = await resolveSessionFor(binding)
      if (!sessionId) {
        console.log('bb: 绑定目标无会话：' + JSON.stringify(binding))
        return
      }
      const agent = agents ? agents.get(sessionId) : undefined
      if (!agent) {
        console.log('bb: 目标会话无活跃 agent：' + sessionId)
        return
      }

      const line = '📱 iMessage' + (chatName ? ' · ' + chatName : '') + (sender ? ' · 来自 ' + sender : '') + '\n' + text
      agent.send({
        id: 'bb-' + Date.now().toString(36) + '-' + Math.floor(Math.random() * 1e9).toString(36),
        role: 'user',
        content: [{ type: 'text', text: line }],
        source: { kind: 'plugin', plugin: 'dsh-bluebubbles' },
      }, 'next-turn', true)
      console.log('bb: 已投递消息到会话 ' + sessionId + '（' + (chatName || sender || chatGuid) + '）')
    }

    // ================= 启动引导 =================
    ctx.effect(() => {
      const bootstrap = async () => {
        // 凭据：env 优先，其次 ~/.zshenv
        if (state.password === '') {
          try {
            const spec = ctx.shell.resolve({ command: 'cat "$HOME/.zshenv" 2>/dev/null', timeoutMs: 8000, stdoutMaxBytes: 32768 })
            const run = await ctx.shell.run(spec)
            if (run.exitCode === 0) {
              const text = (run.stdout && run.stdout.text) || ''
              const m = /(?:^|\n)\s*(?:export\s+)?BLUEBUBBLES_PASSWORD=(?:"([^"]*)"|'([^']*)'|([^\s"']+))/m.exec(text)
              if (m) state.password = (m[1] || m[2] || m[3] || '').trim()
            }
          } catch (err) {
            console.log('bb: 读取 ~/.zshenv 失败：' + (err && err.message ? err.message : err))
          }
        }
        await loadBindings()
        if (state.password !== '') {
          const wh = await ensureWebhook()
          console.log('bb: 凭据就绪（' + state.baseUrl + '），webhook 注册：' + JSON.stringify(wh))
        } else {
          console.log('bb: 未找到 BLUEBUBBLES_PASSWORD（env 与 ~/.zshenv），等待 bluebubbles_configure')
        }
      }
      bootstrap()
    }, 'bootstrap')

    // ================= 工具定义与注册 =================
    const OUTPUT = {
      schema: { type: 'object', additionalProperties: true },
      render(args, value) {
        return [{ type: 'text', text: JSON.stringify(value, null, 2) }]
      },
    }

    function define(options) {
      return {
        name: options.name,
        description: options.description,
        parameters: options.parameters,
        output: OUTPUT,
        async execute(args) {
          try {
            return await options.execute(args)
          } catch (err) {
            return { ok: false, error: String(err && err.message ? err.message : err) }
          }
        },
      }
    }

    const tools = [
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
          return { ok: true, baseUrl: applied.baseUrl, hasPassword: applied.hasPassword, connection: check }
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
        name: 'bluebubbles_bind',
        description: '把 iMessage 会话绑定到 DSH 工作区：新消息将通过 webhook 投递为该工作区活跃会话的用户消息。',
        parameters: {
          type: 'object',
          properties: {
            chatGuid: { type: 'string', description: '会话 GUID（来自 bluebubbles_list_chats）' },
            workspacePath: { type: 'string', description: '目标 DSH 工作区的目录路径' },
          },
          required: ['chatGuid', 'workspacePath'],
        },
        execute: async (args) => {
          const key = 'chat:' + String(args.chatGuid)
          state.bindings[key] = { workspacePath: String(args.workspacePath) }
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
    ctx.provide('bluebubbles', {
      configure: (args) => applyConfig(args),
      ping: () => ping(),
      listChats: (args) => listChats(args || {}),
      getMessages: (args) => getMessages(args || {}),
      sendText: (args) => sendText(args || {}),
      bind: (args) => {
        state.bindings['chat:' + String(args.chatGuid)] = { workspacePath: String(args.workspacePath) }
        return saveBindings()
      },
      listBindings: () => state.bindings,
    })
  },
}
