import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { setImmediate } from 'node:timers/promises'
import test from 'node:test'
import plugin from '../src/index.ts'

// Every host seam is mocked. No filesystem, subprocess, BlueBubbles, or model
// call is made, including during the plugin's asynchronous bootstrap.
process.env.DSH_HOME = '/mock/dsh-quote-test'
process.env.BLUEBUBBLES_PASSWORD = 'mock-password'
process.env.BLUEBUBBLES_BASE_URL = 'http://mock.invalid'
process.env.BLUEBUBBLES_DEBUG = '0'

async function fixture({ parents = {}, lookupError, lookupResult } = {}) {
  const delivered = [], parentRequests = [], files = new Map()
  let route, bridge
  const agent = { session: { header: { version: 0 } }, send: message => delivered.push(message.content[0].text) }
  const fs = {
    resolve: async path => path,
    readText: async path => {
      if (path.endsWith('bindings.json')) return JSON.stringify({ 'chat:C': { sessionId: 'S', relay: false, typing: false } })
      if (path.endsWith('contacts.json')) return JSON.stringify({ '+alice': 'Alice' })
      return files.get(path) || '{}'
    },
    writeText: async (path, content) => files.set(path, content),
  }
  const services = { fs, agents: { get: () => agent }, webServer: { register: value => { route = value; return () => {} } } }
  const ctx = {
    get: name => services[name], fs,
    tools: { register: () => () => {} },
    shell: {
      resolve: spec => spec,
      run: async ({ command }) => {
        // Undo shell single-quote escaping solely to inspect the generated URL.
        const urlText = command.replaceAll("'\\''", "'")
        const match = /\/api\/v1\/message\/(.*?)\?/.exec(urlText)
        let data
        if (match && match[1] !== 'text') {
          parentRequests.push(command)
          if (lookupError) throw lookupError
          if (lookupResult) return lookupResult
          data = { ...(parents[decodeURIComponent(match[1])] || {}) }
          // GET message only loads attachments when its query requests them.
          if (!urlText.includes('?with=attachments&password=')) data.attachments = []
        } else if (command.includes('/api/v1/message/text')) {
          data = { guid: 'E', text: 'sent by bridge' }
        } else {
          data = [{ url: 'http://127.0.0.1:3080/bluebubbles/webhook' }]
        }
        return { exitCode: 0, stdout: { text: JSON.stringify({ status: 200, data }) } }
      },
    },
    on: () => {}, prepend: () => {}, effect: callback => callback(),
    provide: (name, value) => { if (name === 'bluebubbles') bridge = value },
  }
  plugin.apply(ctx)
  await setImmediate()
  async function emit(guid, replyToGuid, extra = {}) {
    const req = new EventEmitter()
    req.socket = { remoteAddress: '127.0.0.1' }
    let response
    const res = { headersSent: false, end: value => { response = value } }
    const handled = route.handler(req, res)
    req.emit('data', Buffer.from(JSON.stringify({ type: 'new-message', data: { guid, replyToGuid, text: guid, chats: [{ guid: 'C' }], ...extra } })))
    req.emit('end')
    await handled
    // processEvent is intentionally detached after the HTTP acknowledgement.
    // Immediate yields drain its microtasks; mocks never leave pending I/O.
    await setImmediate()
    assert.equal(res.statusCode, 200)
    assert.match(response, /^ok-v/)
  }
  return { emit, delivered, parentRequests, bridge }
}

test('cold start and ordinary predecessor chain do not fetch or quote', async () => {
  const f = await fixture()
  await f.emit('A', 'P'); await f.emit('B', 'A'); await f.emit('C', 'B')
  assert.equal(f.delivered.length, 3)
  assert.ok(f.delivered.every(text => !text.includes('↪ 引用')))
  assert.equal(f.parentRequests.length, 0)
})

test('older quote resolves its author and collapses/truncates code points', async () => {
  const f = await fixture({ parents: { P: { text: ' \n' + '😀'.repeat(41) + '\t ', handle: { address: '+alice' } } } })
  await f.emit('A'); await f.emit('Q', 'P')
  assert.equal(f.delivered.length, 2)
  assert.ok(f.delivered[1].includes('↪ 引用（Alice）：「' + '😀'.repeat(40) + '…」\n\nQ'))
  assert.equal(f.parentRequests.length, 1)
})

test('a stale duplicate cannot create a false quote of the predecessor', async () => {
  const f = await fixture({ parents: { B: { text: 'B' } } })
  await f.emit('A'); await f.emit('B', 'A'); await f.emit('A'); await f.emit('C', 'B')
  assert.equal(f.delivered.length, 3)
  assert.ok(!f.delivered[2].includes('↪ 引用'))
  assert.equal(f.parentRequests.length, 0)
})

test('a stale duplicate cannot suppress a true older quote', async () => {
  const f = await fixture({ parents: { A: { text: 'A', handle: { displayName: 'Parent author' } } } })
  await f.emit('A'); await f.emit('B', 'A'); await f.emit('A'); await f.emit('Q', 'A')
  assert.equal(f.delivered.length, 3)
  assert.match(f.delivered[2], /↪ 引用（Parent author）：「A」/)
})

test('first REST-send echo advances history even when delivery dedup already knows its guid', async () => {
  const f = await fixture({ parents: { E: { text: 'sent by bridge' } } })
  await f.emit('A')
  await f.bridge.sendText({ chatGuid: 'C', text: 'sent by bridge' })
  await f.emit('E', 'A', { text: 'sent by bridge', isFromMe: true })
  await f.emit('C', 'E')
  assert.equal(f.delivered.length, 2)
  assert.ok(!f.delivered[1].includes('↪ 引用'))
  assert.equal(f.parentRequests.length, 0)
})

test('first CLI-send echo advances history before its tempGuid drop', async () => {
  const f = await fixture()
  await f.emit('A'); await f.emit('E', 'A', { isFromMe: true, tempGuid: 'bbcli-example' }); await f.emit('C', 'E')
  assert.equal(f.delivered.length, 2)
  assert.equal(f.parentRequests.length, 0)
})

test('a known older timestamp cannot rewind history or invent a quote for delayed delivery', async () => {
  const f = await fixture()
  await f.emit('A', undefined, { dateCreated: 1_800_000_001_000 })
  await f.emit('B', 'A', { dateCreated: 1_800_000_003_000 })
  await f.emit('delayed', 'unknown', { dateCreated: 1_800_000_002_000 })
  await f.emit('C', 'B', { dateCreated: 1_800_000_004_000 })
  assert.equal(f.delivered.length, 4)
  assert.equal(f.parentRequests.length, 0)
})

test('attachment-only parents request attachments and render their fallback', async () => {
  const f = await fixture({ parents: { P: { text: null, attachments: [{ guid: 'file' }], isFromMe: true } } })
  await f.emit('A'); await f.emit('Q', 'P')
  assert.match(f.parentRequests[0], /\/message\/P\?with=attachments&password=/)
  assert.match(f.delivered[1], /↪ 引用（我）：「（附件）」/)
})

test('parent guid is encoded as a path segment and shell quotes stay escaped', async () => {
  const guid = "P/ ?&#'"
  const f = await fixture({ parents: { [guid]: { text: 'safe parent' } } })
  await f.emit('A'); await f.emit('Q', guid)
  const expected = encodeURIComponent(guid).replaceAll("'", "'\\''")
  assert.ok(f.parentRequests[0].includes('/message/' + expected + '?with=attachments&password='))
  assert.match(f.delivered[1], /safe parent/)
})

test('throwing parent lookup preserves delivery of the incoming body', async () => {
  const f = await fixture({ lookupError: new Error('mock infrastructure failure') })
  await f.emit('A'); await f.emit('Q', 'P')
  assert.equal(f.delivered.length, 2)
  assert.ok(f.delivered[1].endsWith('\nQ'))
  assert.ok(!f.delivered[1].includes('↪ 引用'))
})

test('failed parent lookup also preserves the incoming body', async () => {
  const f = await fixture({ lookupResult: { exitCode: 1, stderr: { text: 'mock failed request' } } })
  await f.emit('A'); await f.emit('Q', 'P')
  assert.equal(f.delivered.length, 2)
  assert.ok(f.delivered[1].endsWith('\nQ'))
})

test('tapbacks retain their server-rendered text without a second quote', async () => {
  const f = await fixture()
  await f.emit('A'); await f.emit('T', 'P', { text: 'Liked: parent', associatedMessageGuid: 'p:0/P', associatedMessageType: 2001 })
  assert.equal(f.delivered.length, 2)
  assert.equal(f.parentRequests.length, 0)
  assert.ok(f.delivered[1].endsWith('\nLiked: parent'))
})
