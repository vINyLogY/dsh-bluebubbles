#!/usr/bin/env node
// bb-channel — BlueBubbles (iMessage) 命令行工具。
// 与 dsh 桥插件共享同一套状态文件（~/.dsh/bluebubbles-{bindings,contacts}.json），
// CLI 改绑定后插件在下一条入站消息时自动热重读。
//
// 凭据链：环境变量 → ~/.dsh/.env → ~/.zshenv（BLUEBUBBLES_PASSWORD / BLUEBUBBLES_BASE_URL）。
// 输出一律为 pretty JSON（可 jq）；错误写 stderr 且 exit 1。

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, basename } from 'node:path'

const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh')
const BINDINGS_PATH = process.env.BLUEBUBBLES_BINDINGS || join(DSH_HOME, 'bluebubbles-bindings.json')
const CONTACTS_PATH = process.env.BLUEBUBBLES_CONTACTS || join(DSH_HOME, 'bluebubbles-contacts.json')
const ENV_PATH = join(DSH_HOME, '.env')
const DEFAULT_WEBHOOK_URL = 'http://127.0.0.1:3080/bluebubbles/webhook'

// ---------- 配置解析 ----------
function parseEnvFile(path) {
  try {
    const text = readFileSync(path, 'utf8')
    const out = {}
    for (const line of text.split('\n')) {
      const m = line.match(/^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*)\s*$/)
      if (!m) continue
      let v = m[2]
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1)
      out[m[1]] = v
    }
    return out
  } catch { return {} }
}

function resolveConfig() {
  const fromEnvFile = { ...parseEnvFile(join(homedir(), '.zshenv')), ...parseEnvFile(ENV_PATH) }
  const pick = (k) => process.env[k] || fromEnvFile[k] || ''
  return {
    baseUrl: (pick('BLUEBUBBLES_BASE_URL') || 'http://localhost:1234').replace(/\/+$/, ''),
    password: pick('BLUEBUBBLES_PASSWORD'),
  }
}

const cfg = resolveConfig()

function url(path) {
  const sep = path.includes('?') ? '&' : '?'
  return `${cfg.baseUrl}/api/v1/${path}${sep}password=${encodeURIComponent(cfg.password)}`
}

function die(msg) {
  console.error('bb-channel: ' + msg)
  process.exit(1)
}

function requirePassword() {
  if (!cfg.password) die('未找到 BLUEBUBBLES_PASSWORD（env / ~/.dsh/.env / ~/.zshenv），先运行 bb-channel configure --password <pw>')
}

async function api(method, path, body) {
  requirePassword()
  const res = await fetch(url(path), {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30000),
  })
  const parsed = await res.json().catch(() => null)
  if (!parsed) die('无法解析 BlueBubbles 响应（HTTP ' + res.status + '）')
  if (typeof parsed.status === 'number' && parsed.status >= 400) {
    const e = parsed.error
    die('BlueBubbles 错误：' + (e ? (e.message || e.error || e.type || JSON.stringify(e)) : 'HTTP ' + parsed.status))
  }
  return Object.prototype.hasOwnProperty.call(parsed, 'data') ? parsed.data : parsed
}

// ---------- 状态文件 ----------
function readJson(path, fallback) {
  try { return JSON.parse(readFileSync(path, 'utf8')) } catch { return fallback }
}
function writeJson(path, value) {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n')
}
const contacts = () => readJson(CONTACTS_PATH, {})

// ---------- 展示辅助 ----------
function senderOf(m, cs) {
  const addr = (m.handle && m.handle.address) || (m.isFromMe ? 'me' : '?')
  const name = (!m.isFromMe && cs[addr]) || null
  return name ? `${name}（${addr}）` : addr
}

function compactMessage(m, cs) {
  return {
    guid: m.guid,
    from: senderOf(m, cs),
    isFromMe: !!m.isFromMe,
    text: m.text ?? null,
    date: m.dateCreated ? new Date(m.dateCreated).toISOString() : null,
    attachments: Array.isArray(m.attachments) && m.attachments.length
      ? m.attachments.map((a) => ({ guid: a.guid, name: a.transferName, mime: a.mimeType }))
      : undefined,
  }
}

// 噪音过滤：any;-;any 占位会话、无参与者且无显示名的空会话、配对码类系统消息
function isNoiseChat(c) {
  if (!c || !c.guid) return true
  if (c.guid === 'any;-;any') return true
  const noPeople = (!c.displayName || c.displayName === '') && (!Array.isArray(c.participants) || c.participants.length === 0)
  if (noPeople) return true
  const t = (c.lastMessage && c.lastMessage.text) || ''
  if (/pairing|配对码|verification code/i.test(t) && !c.displayName) return true
  return false
}

// ---------- 子命令 ----------
const HELP = `bb-channel — BlueBubbles (iMessage) CLI

用法: bb-channel <命令> [参数]

  ping                                  连通性/鉴权检查
  chats [--limit N] [--all]             列出会话（默认过滤占位/配对码噪音，--all 全量）
  messages <chatGuid> [--limit N]       读最近消息（带发送者显示名）
  send <chatGuid> <文本...>             发文本（--method private-api 可选）
  send-attachment <chatGuid> <文件> [--name X]   发附件（默认 private-api）
  attachment <guid> [--name X] [--dir D]       下载附件（默认存 $DSH_HOME/bluebubbles-media）
  bind <chatGuid> (--workspace PATH | --session ID)   绑定会话到 DSH 工作区/会话
  unbind <chatGuid>                     解绑
  bindings                              查看绑定表
  contacts                              查看通讯录（地址 → 显示名）
  set-contact <地址> <名字>              写通讯录（注入消息和 messages 输出都会用）
  webhook [--url URL]                   查看/确保 DSH webhook 已注册
  configure [--base-url URL] [--password PW]   写入 ~/.dsh/.env

凭据链: 环境变量 → ~/.dsh/.env → ~/.zshenv。输出为 JSON，可 jq。`

function argValue(args, flag) {
  const i = args.indexOf(flag)
  return i !== -1 && i + 1 < args.length ? args[i + 1] : null
}
function hasFlag(args, flag) { return args.includes(flag) }
function positional(args) {
  const flagsWithValue = ['--limit', '--method', '--name', '--dir', '--workspace', '--session', '--url', '--base-url', '--password']
  const out = []
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--')) {
      if (flagsWithValue.includes(args[i])) i++
      continue
    }
    out.push(args[i])
  }
  return out
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2)
  const pos = positional(rest)
  const out = (v) => console.log(JSON.stringify(v, null, 2))

  switch (cmd) {
    case undefined:
    case '--help':
    case '-h':
    case 'help':
      console.log(HELP)
      return

    case 'ping': {
      const started = Date.now()
      const data = await api('GET', 'ping')
      out({ ok: true, latencyMs: Date.now() - started, server: data })
      return
    }

    case 'chats': {
      const limit = Math.min(Math.max(parseInt(argValue(rest, '--limit') || '50', 10) || 50, 1), 100)
      const data = await api('POST', 'chat/query', { limit, offset: 0, sort: 'lastmessage', with: ['lastmessage', 'participants'] })
      const all = (Array.isArray(data) ? data : [])
      const filtered = hasFlag(rest, '--all') ? all : all.filter((c) => !isNoiseChat(c))
      out({
        total: filtered.length,
        hiddenNoise: all.length - filtered.length,
        chats: filtered.map((c) => ({
          guid: c.guid,
          displayName: c.displayName || null,
          participants: (c.participants || []).map((p) => p.address),
          lastMessage: c.lastMessage ? compactMessage(c.lastMessage, contacts()) : null,
        })),
      })
      return
    }

    case 'messages': {
      const chatGuid = pos[0] || die('messages 需要 <chatGuid>')
      const limit = Math.min(Math.max(parseInt(argValue(rest, '--limit') || '25', 10) || 25, 1), 100)
      const data = await api('GET', 'chat/' + encodeURIComponent(chatGuid) + '/message?limit=' + limit + '&sort=DESC')
      const cs = contacts()
      out({ count: (data || []).length, messages: (data || []).map((m) => compactMessage(m, cs)) })
      return
    }

    case 'send': {
      const chatGuid = pos[0] || die('send 需要 <chatGuid> <文本>')
      const text = pos.slice(1).join(' ') || die('send 需要文本内容')
      const method = argValue(rest, '--method') || 'apple-script'
      const tempGuid = 'bbcli-' + Date.now().toString(36) + '-' + Math.floor(Math.random() * 1e9).toString(36)
      const data = await api('POST', 'message/text', { chatGuid, tempGuid, message: text, method })
      out({ ok: true, guid: (data && data.guid) || null, tempGuid })
      return
    }

    case 'send-attachment': {
      const chatGuid = pos[0] || die('send-attachment 需要 <chatGuid> <文件路径>')
      const filePath = pos[1] || die('send-attachment 需要文件路径')
      if (!existsSync(filePath)) die('文件不存在：' + filePath)
      const name = argValue(rest, '--name') || basename(filePath)
      const method = argValue(rest, '--method') || 'private-api'
      const tempGuid = 'bbcli-' + Date.now().toString(36) + '-' + Math.floor(Math.random() * 1e9).toString(36)
      const form = new FormData()
      form.append('chatGuid', chatGuid)
      form.append('tempGuid', tempGuid)
      form.append('method', method)
      form.append('name', name)
      const bytes = readFileSync(filePath)
      form.append('attachment', new Blob([bytes]), name)
      requirePassword()
      const res = await fetch(url('message/attachment'), { method: 'POST', body: form, signal: AbortSignal.timeout(60000) })
      const parsed = await res.json().catch(() => null)
      if (!parsed || (typeof parsed.status === 'number' && parsed.status >= 400)) {
        die('发送失败：' + JSON.stringify(parsed && parsed.error ? parsed.error : parsed))
      }
      out({ ok: true, guid: (parsed.data && parsed.data.guid) || null, name })
      return
    }

    case 'attachment': {
      const guid = pos[0] || die('attachment 需要 <guid>')
      const name = (argValue(rest, '--name') || 'attachment').replace(/[^\w.\-]+/g, '_').slice(0, 80)
      const dir = argValue(rest, '--dir') || join(DSH_HOME, 'bluebubbles-media')
      mkdirSync(dir, { recursive: true })
      requirePassword()
      const res = await fetch(url('attachment/' + encodeURIComponent(guid) + '/download'), { signal: AbortSignal.timeout(60000) })
      if (!res.ok) die('下载失败：HTTP ' + res.status)
      const filePath = join(dir, guid + '-' + name)
      writeFileSync(filePath, Buffer.from(await res.arrayBuffer()))
      out({ ok: true, guid, path: filePath })
      return
    }

    case 'bind': {
      const chatGuid = pos[0] || die('bind 需要 <chatGuid>')
      const workspace = argValue(rest, '--workspace')
      const session = argValue(rest, '--session')
      if (!workspace && !session) die('bind 需要 --workspace PATH 或 --session ID')
      const bindings = readJson(BINDINGS_PATH, {})
      bindings['chat:' + chatGuid] = session ? { sessionId: session } : { workspacePath: workspace }
      writeJson(BINDINGS_PATH, bindings)
      out({ ok: true, key: 'chat:' + chatGuid, binding: bindings['chat:' + chatGuid], note: '插件在下一条入站消息时热生效' })
      return
    }

    case 'unbind': {
      const chatGuid = pos[0] || die('unbind 需要 <chatGuid>')
      const bindings = readJson(BINDINGS_PATH, {})
      const existed = Object.prototype.hasOwnProperty.call(bindings, 'chat:' + chatGuid)
      delete bindings['chat:' + chatGuid]
      writeJson(BINDINGS_PATH, bindings)
      out({ ok: true, removed: existed })
      return
    }

    case 'bindings':
      out({ path: BINDINGS_PATH, bindings: readJson(BINDINGS_PATH, {}) })
      return

    case 'contacts':
      out({ path: CONTACTS_PATH, contacts: contacts() })
      return

    case 'set-contact': {
      const addr = pos[0] || die('set-contact 需要 <地址> <名字>')
      const name = pos[1] || die('set-contact 需要 <名字>')
      const cs = contacts()
      cs[addr] = name
      writeJson(CONTACTS_PATH, cs)
      out({ ok: true, [addr]: name })
      return
    }

    case 'webhook': {
      const webhookUrl = argValue(rest, '--url') || DEFAULT_WEBHOOK_URL
      const list = await api('GET', 'webhook')
      const existing = Array.isArray(list) ? list.find((w) => w && w.url === webhookUrl) : null
      if (existing) { out({ ok: true, registered: true, id: existing.id, url: webhookUrl, note: '已存在' }); return }
      const created = await api('POST', 'webhook', { url: webhookUrl, events: ['new-message'] })
      out({ ok: true, registered: true, id: (created && created.id) || null, url: webhookUrl })
      return
    }

    case 'configure': {
      const baseUrl = argValue(rest, '--base-url')
      const password = argValue(rest, '--password')
      if (!baseUrl && !password) die('configure 需要 --base-url 和/或 --password')
      let text = existsSync(ENV_PATH) ? readFileSync(ENV_PATH, 'utf8') : ''
      const upsert = (t, key, value) => {
        const re = new RegExp('^\\s*#?\\s*' + key + '=.*$', 'm')
        return re.test(t) ? t.replace(re, key + '=' + value) : t.replace(/\n?$/, '\n') + key + '=' + value + '\n'
      }
      if (password) text = upsert(text, 'BLUEBUBBLES_PASSWORD', password)
      if (baseUrl) text = upsert(text, 'BLUEBUBBLES_BASE_URL', baseUrl)
      writeFileSync(ENV_PATH, text)
      out({ ok: true, envPath: ENV_PATH, hasPassword: !!(password || cfg.password), baseUrl: baseUrl || cfg.baseUrl, note: 'DSH 进程下次重启或桥热重载时生效' })
      return
    }

    default:
      die('未知命令：' + cmd + '（bb-channel help 查看用法）')
  }
}

main().catch((err) => die(err instanceof Error ? err.message : String(err)))
