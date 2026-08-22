#!/usr/bin/env node
// bb-channel — BlueBubbles (iMessage) command-line tool.
// Shares the same state files with the DSH bridge plugin
// (~/.dsh/bluebubbles-{bindings,contacts}.json); the plugin hot re-reads them
// before the next inbound message, so CLI edits take effect immediately.
// Plain .mjs on purpose: zero dependencies, runs on any modern Node without
// the >= 23.6 type-stripping the TypeScript plugins require, and stays ESM no
// matter where the file is symlinked or copied.
//
// Credential chain: environment → ~/.dsh/.env → ~/.zshenv
// (BLUEBUBBLES_PASSWORD / BLUEBUBBLES_BASE_URL).
// Output is always pretty JSON (jq-friendly); errors go to stderr with exit 1.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, basename } from 'node:path'

const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh')
const BINDINGS_PATH = process.env.BLUEBUBBLES_BINDINGS || join(DSH_HOME, 'bluebubbles-bindings.json')
const CONTACTS_PATH = process.env.BLUEBUBBLES_CONTACTS || join(DSH_HOME, 'bluebubbles-contacts.json')
const ENV_PATH = join(DSH_HOME, '.env')
const DEFAULT_WEBHOOK_URL = 'http://127.0.0.1:3080/bluebubbles/webhook'

// ---------- config resolution ----------
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
  if (!cfg.password) die('BLUEBUBBLES_PASSWORD not found (env / ~/.dsh/.env / ~/.zshenv); run bb-channel configure --password <pw> first')
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
  if (!parsed) die('cannot parse BlueBubbles response (HTTP ' + res.status + ')')
  if (typeof parsed.status === 'number' && parsed.status >= 400) {
    const e = parsed.error
    die('BlueBubbles error: ' + (e ? (e.message || e.error || e.type || JSON.stringify(e)) : 'HTTP ' + parsed.status))
  }
  return Object.prototype.hasOwnProperty.call(parsed, 'data') ? parsed.data : parsed
}

// ---------- state files ----------
function readJson(path, fallback) {
  try { return JSON.parse(readFileSync(path, 'utf8')) } catch { return fallback }
}
function writeJson(path, value) {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n')
}
const contacts = () => readJson(CONTACTS_PATH, {})

// ---------- display helpers ----------
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

// noise filter: the any;-;any placeholder chat, empty chats with neither
// participants nor a display name, and pairing-code style system messages
function isNoiseChat(c) {
  if (!c || !c.guid) return true
  if (c.guid === 'any;-;any') return true
  const noPeople = (!c.displayName || c.displayName === '') && (!Array.isArray(c.participants) || c.participants.length === 0)
  if (noPeople) return true
  const t = (c.lastMessage && c.lastMessage.text) || ''
  if (/pairing|配对码|verification code/i.test(t) && !c.displayName) return true
  return false
}

// ---------- subcommands ----------
const HELP = `bb-channel — BlueBubbles (iMessage) CLI

Usage: bb-channel <command> [args]

  ping                                  connectivity/auth check
  chats [--limit N] [--all]             list chats (placeholder/pairing-code noise hidden unless --all)
  messages <chatGuid> [--limit N]       read recent messages (with sender display names)
  send <chatGuid> <text...>             send text (--method private-api optional)
  send-attachment <chatGuid> <file> [--name X]   send an attachment (private-api default)
  attachment <guid> [--name X] [--dir D]       download an attachment (defaults into $DSH_HOME/bluebubbles-media)
  bind <chatGuid> (--workspace PATH | --session ID) [--relay] [--no-typing]   bind a chat to a DSH workspace/session
  unbind <chatGuid>                     remove a binding
  bindings                              show the binding table
  contacts                              show the address book (address → display name)
  set-contact <address> <name>          write the address book (used by injected messages and messages output)
  webhook [--url URL]                   check/ensure the DSH webhook is registered
  configure [--base-url URL] [--password PW]   write ~/.dsh/.env

Credential chain: environment → ~/.dsh/.env → ~/.zshenv. Output is JSON, jq-friendly.`

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
      const chatGuid = pos[0] || die('messages requires <chatGuid>')
      const limit = Math.min(Math.max(parseInt(argValue(rest, '--limit') || '25', 10) || 25, 1), 100)
      const data = await api('GET', 'chat/' + encodeURIComponent(chatGuid) + '/message?limit=' + limit + '&sort=DESC')
      const cs = contacts()
      out({ count: (data || []).length, messages: (data || []).map((m) => compactMessage(m, cs)) })
      return
    }

    case 'send': {
      const chatGuid = pos[0] || die('send requires <chatGuid> <text>')
      const text = pos.slice(1).join(' ') || die('send requires text content')
      const method = argValue(rest, '--method') || 'apple-script'
      const tempGuid = 'bbcli-' + Date.now().toString(36) + '-' + Math.floor(Math.random() * 1e9).toString(36)
      const data = await api('POST', 'message/text', { chatGuid, tempGuid, message: text, method })
      out({ ok: true, guid: (data && data.guid) || null, tempGuid })
      return
    }

    case 'send-attachment': {
      const chatGuid = pos[0] || die('send-attachment requires <chatGuid> <file>')
      const filePath = pos[1] || die('send-attachment requires a file path')
      if (!existsSync(filePath)) die('file not found: ' + filePath)
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
        die('send failed: ' + JSON.stringify(parsed && parsed.error ? parsed.error : parsed))
      }
      out({ ok: true, guid: (parsed.data && parsed.data.guid) || null, name })
      return
    }

    case 'attachment': {
      const guid = pos[0] || die('attachment requires <guid>')
      const name = (argValue(rest, '--name') || 'attachment').replace(/[^\w.\-]+/g, '_').slice(0, 80)
      const dir = argValue(rest, '--dir') || join(DSH_HOME, 'bluebubbles-media')
      mkdirSync(dir, { recursive: true })
      requirePassword()
      const res = await fetch(url('attachment/' + encodeURIComponent(guid) + '/download'), { signal: AbortSignal.timeout(60000) })
      if (!res.ok) die('download failed: HTTP ' + res.status)
      const filePath = join(dir, guid + '-' + name)
      writeFileSync(filePath, Buffer.from(await res.arrayBuffer()))
      out({ ok: true, guid, path: filePath })
      return
    }

    case 'bind': {
      const chatGuid = pos[0] || die('bind requires <chatGuid>')
      const workspace = argValue(rest, '--workspace')
      const session = argValue(rest, '--session')
      if (!workspace && !session) die('bind requires --workspace PATH or --session ID')
      const binding = session ? { sessionId: session } : { workspacePath: workspace }
      // --relay: auto-deliver text replies of iMessage-triggered turns back to the
      // chat; --no-typing: disable the "typing…" indicator (on by default)
      if (hasFlag(rest, '--relay')) binding.relay = true
      if (hasFlag(rest, '--no-typing')) binding.typing = false
      const bindings = readJson(BINDINGS_PATH, {})
      bindings['chat:' + chatGuid] = binding
      writeJson(BINDINGS_PATH, bindings)
      out({ ok: true, key: 'chat:' + chatGuid, binding, note: 'the plugin hot-applies this on the next inbound message' })
      return
    }

    case 'unbind': {
      const chatGuid = pos[0] || die('unbind requires <chatGuid>')
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
      const addr = pos[0] || die('set-contact requires <address> <name>')
      const name = pos[1] || die('set-contact requires <name>')
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
      if (existing) { out({ ok: true, registered: true, id: existing.id, url: webhookUrl, note: 'already exists' }); return }
      const created = await api('POST', 'webhook', { url: webhookUrl, events: ['new-message'] })
      out({ ok: true, registered: true, id: (created && created.id) || null, url: webhookUrl })
      return
    }

    case 'configure': {
      const baseUrl = argValue(rest, '--base-url')
      const password = argValue(rest, '--password')
      if (!baseUrl && !password) die('configure requires --base-url and/or --password')
      let text = existsSync(ENV_PATH) ? readFileSync(ENV_PATH, 'utf8') : ''
      const upsert = (t, key, value) => {
        const re = new RegExp('^\\s*#?\\s*' + key + '=.*$', 'm')
        return re.test(t) ? t.replace(re, key + '=' + value) : t.replace(/\n?$/, '\n') + key + '=' + value + '\n'
      }
      if (password) text = upsert(text, 'BLUEBUBBLES_PASSWORD', password)
      if (baseUrl) text = upsert(text, 'BLUEBUBBLES_BASE_URL', baseUrl)
      writeFileSync(ENV_PATH, text)
      out({ ok: true, envPath: ENV_PATH, hasPassword: !!(password || cfg.password), baseUrl: baseUrl || cfg.baseUrl, note: 'takes effect on the next DSH restart or bridge reload' })
      return
    }

    default:
      die('unknown command: ' + cmd + ' (see bb-channel help)')
  }
}

main().catch((err) => die(err instanceof Error ? err.message : String(err)))
