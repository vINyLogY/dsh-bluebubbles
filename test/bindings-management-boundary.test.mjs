import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, readFile, writeFile, mkdir, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventEmitter } from 'node:events'
import { setImmediate } from 'node:timers/promises'
import { readBindings, updateBindings, withBindingsLock } from '../src/bindings-store.ts'
import bridgePlugin from '../src/index.ts'

// All files are synthetic, in an exclusively owned mkdtemp. No live DSH,
// BlueBubbles, credentials, provider, or session history is accessed.
async function fixture(t, table = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-binding-boundary-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const path = join(root, 'bindings.json')
  await writeFile(path, JSON.stringify(table), { mode: 0o600 })
  return { root, path }
}
const errorCode = code => error => error.code === code

test('CAS preserves an external CLI change and rejects a stale UI revision', async t => {
  const { path } = await fixture(t, { 'chat:A': { sessionId: 'S1', relay: true } })
  const old = await readBindings(path)
  await updateBindings(path, old.revision, table => { table['chat:B'] = { sessionId: 'S2' } })
  await assert.rejects(updateBindings(path, old.revision, table => { delete table['chat:A'] }), errorCode('conflict'))
  assert.deepEqual((await readBindings(path)).bindings, { 'chat:A': { sessionId: 'S1', relay: true }, 'chat:B': { sessionId: 'S2' } })
})

test('a nonparticipating editor observed during validation is not overwritten', async t => {
  const { root, path } = await fixture(t)
  const old = await readBindings(path)
  const external = { 'chat:external': { workspacePath: '/synthetic/workspace', typing: false } }
  await assert.rejects(updateBindings(path, old.revision, async table => {
    table['chat:UI'] = { sessionId: 'S' }
    await writeFile(path, JSON.stringify(external))
  }), errorCode('conflict'))
  assert.deepEqual((await readBindings(path)).bindings, external)
  assert.deepEqual(await readdir(root), ['bindings.json'])
})

test('cooperating writers cannot enter a locked mutation concurrently', async t => {
  const { path } = await fixture(t)
  const initial = await readBindings(path)
  let entered, release
  const ready = new Promise(resolve => { entered = resolve })
  const gate = new Promise(resolve => { release = resolve })
  const first = updateBindings(path, initial.revision, async table => {
    entered(); await gate; table['chat:A'] = { sessionId: 'S1' }
  })
  await ready
  await assert.rejects(updateBindings(path, initial.revision, table => { table['chat:B'] = { sessionId: 'S2' } }), errorCode('busy'))
  release(); await first
  assert.deepEqual((await readBindings(path)).bindings, { 'chat:A': { sessionId: 'S1' } })
})

test('failed validation leaves original bytes and permits the next mutation', async t => {
  const { root, path } = await fixture(t, { 'chat:A': { sessionId: 'S', custom: { retained: true } } })
  const before = await readFile(path)
  const old = await readBindings(path)
  await assert.rejects(updateBindings(path, old.revision, () => { throw new Error('synthetic failure') }), errorCode('persistence-failed'))
  assert.deepEqual(await readFile(path), before)
  assert.deepEqual(await readdir(root), ['bindings.json'])
  await updateBindings(path, old.revision, table => { table['chat:A'].typing = false })
  assert.equal((await readBindings(path)).bindings['chat:A'].custom.retained, true)
})

test('malformed persisted state is refused rather than silently replaced', async t => {
  const { path } = await fixture(t)
  await writeFile(path, '{not json')
  await assert.rejects(readBindings(path), errorCode('invalid-store'))
  await assert.rejects(updateBindings(path, undefined, table => { table['chat:A'] = { sessionId: 'S' } }), errorCode('invalid-store'))
  assert.equal(await readFile(path, 'utf8'), '{not json')
})

test('publication failure never returns success and cleans its temporary artifacts', async t => {
  const { root, path } = await fixture(t)
  const old = await readBindings(path)
  await assert.rejects(updateBindings(path, old.revision, async table => {
    table['chat:A'] = { sessionId: 'S' }
    // Force rename(file, directory) failure only within the owned fixture.
    await rm(path); await mkdir(path)
  }), errorCode('persistence-failed'))
  assert.deepEqual(await readdir(root), ['bindings.json'])
})

test('transport lease blocks cooperative CLI writes and releases even on transport error', async t => {
  const { root, path } = await fixture(t)
  let entered, release
  const ready = new Promise(resolve => { entered = resolve })
  const gate = new Promise(resolve => { release = resolve })
  const send = withBindingsLock(path, async () => { entered(); await gate; throw new Error('synthetic transport error') })
  const rejection = assert.rejects(send, /synthetic transport error/)
  await ready
  await assert.rejects(updateBindings(path, undefined, table => { table['chat:A'] = { sessionId: 'S' } }), errorCode('busy'))
  release(); await rejection
  assert.deepEqual(await readdir(root), ['bindings.json'])
  await updateBindings(path, undefined, table => { table['chat:A'] = { sessionId: 'S' } })
})

async function bridgeFixture(t, table) {
  const f = await fixture(t, table)
  const env = { DSH_HOME: f.root, BLUEBUBBLES_BINDINGS: f.path,
    BLUEBUBBLES_CONTACTS: join(f.root, 'contacts.json'), BLUEBUBBLES_RELAY_STATE: join(f.root, 'relay.json'),
    BLUEBUBBLES_PASSWORD: 'synthetic', BLUEBUBBLES_BASE_URL: 'http://mock.invalid', BLUEBUBBLES_DEBUG: '0', BLUEBUBBLES_GUARD: '0' }
  const previous = Object.fromEntries(Object.keys(env).map(k => [k, process.env[k]]))
  Object.assign(process.env, env)
  t.after(() => { for (const [k, v] of Object.entries(previous)) v === undefined ? delete process.env[k] : process.env[k] = v })
  let api, route, deliveryResolver
  const listeners = new Map(), sends = []
  const agent = { status: 'idle', session: { header: { version: 0 } }, send() { deliveryResolver?.() }, async runMaintenance(fn) { return fn() } }
  const services = {
    fs: { async resolve(p) { return p }, async readText(p) { try { return await readFile(p, 'utf8') } catch { return '{}' } }, async writeText(p, s) { await writeFile(p, s) } },
    agents: { get() { return agent } },
    workspaceRegistry: { async resolveByPath() { return { sessionIds: ['S2'] } } },
    sessionPersistence: { async list() { return [{ id: 'S1' }, { id: 'S2' }] }, async inspect(id) { return { meta: { id, agentPreset: 'synthetic-preset' }, events: [] } } },
    agentPresets: { async resolve(id) { return { id } } },
    webServer: { register(value) { route = value; return () => {} } },
  }
  const ctx = {
    get: n => services[n], fs: services.fs,
    tools: { register() { return () => {} } },
    shell: { resolve: x => x, async run({ command }) {
      let data = [{ url: 'http://127.0.0.1:3080/bluebubbles/webhook' }]
      const chat = /\/api\/v1\/chat\/([^?']+)\?/.exec(command)
      if (chat) data = { guid: decodeURIComponent(chat[1]) }
      if (command.includes('/message/text?')) { sends.push(command); data = { guid: 'synthetic-outbound' } }
      return { exitCode: 0, stdout: { text: JSON.stringify({ status: 200, data }) } }
    } },
    on(name, fn) { listeners.set(name, fn) }, prepend() {}, effect(fn) { fn() },
    provide(name, value) { if (name === 'bluebubbles') api = value },
  }
  bridgePlugin.apply(ctx); await setImmediate()
  async function inbound(chat = 'A', waitDelivery = true) {
    const accepted = new Promise(resolve => { deliveryResolver = resolve })
    const req = new EventEmitter(); req.socket = { remoteAddress: '127.0.0.1' }
    const res = { end() {}, headersSent: false }
    const done = route.handler(req, res)
    req.emit('data', Buffer.from(JSON.stringify({ type: 'new-message', data: { guid: 'input-'+chat, text: 'synthetic', chats: [{ guid: chat }] } })))
    req.emit('end'); await done
    if (waitDelivery) await accepted
    await setImmediate()
  }
  return { ...f, api, agent, services, listeners, sends, inbound }
}

test('management refuses an explicit session already owned by a legacy workspace alias', async t => {
  const f = await bridgeFixture(t, { 'chat:A': { workspacePath: '/synthetic/workspace', relay: true } })
  const before = await readFile(f.path)
  const view = await f.api.bindingManagement.list()
  await assert.rejects(f.api.bindingManagement.bind({ chatGuid: 'B', sessionId: 'S2', relay: true, expectedRevision: view.revision }), errorCode('session-conflict'))
  assert.deepEqual(await readFile(f.path), before)
})

test('a live relay trigger refuses unbind and still sends only to the original chat', async t => {
  const f = await bridgeFixture(t, { 'chat:A': { sessionId: 'S1', relay: true, typing: false } })
  await f.inbound()
  const view = await f.api.bindingManagement.list()
  await assert.rejects(f.api.bindingManagement.unbind({ chatGuid: 'A', expectedRevision: view.revision }), errorCode('busy'))
  f.listeners.get('session/event')({ id: 'S1' }, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'synthetic reply' }] } } })
  await f.api.whenRelayIdle()
  assert.equal(f.sends.length, 1)
  assert.match(f.sends[0], /"chatGuid":"A"/)
  assert.ok((await readBindings(f.path)).bindings['chat:A'])
})

test('management refuses a running agent even without a bridge relay trigger', async t => {
  const f = await bridgeFixture(t, { 'chat:A': { sessionId: 'S1' } })
  f.agent.status = 'running'
  const view = await f.api.bindingManagement.list()
  await assert.rejects(f.api.bindingManagement.unbind({ chatGuid: 'A', expectedRevision: view.revision }), errorCode('busy'))
  assert.ok((await readBindings(f.path)).bindings['chat:A'])
})

test('failed management persistence does not alter the active in-memory binding', async t => {
  const f = await bridgeFixture(t, { 'chat:A': { sessionId: 'S1', relay: true, typing: false } })
  const view = await f.api.bindingManagement.list()
  await writeFile(f.path, '{invalid synthetic json')
  await assert.rejects(f.api.bindingManagement.unbind({ chatGuid: 'A', expectedRevision: view.revision }), errorCode('invalid-store'))
  assert.deepEqual(f.api.listBindings(), { 'chat:A': { sessionId: 'S1', relay: true, typing: false } })
  assert.equal(await readFile(f.path, 'utf8'), '{invalid synthetic json')
})

test('exact-session bind preserves old extension fields but removes the dynamic workspace alias', async t => {
  const f = await bridgeFixture(t, { 'chat:A': { workspacePath: '/synthetic/workspace', typing: false, retained: { version: 1 } } })
  const view = await f.api.bindingManagement.list()
  await f.api.bindingManagement.bind({ chatGuid: 'A', sessionId: 'S1', relay: true, expectedRevision: view.revision })
  assert.deepEqual((await readBindings(f.path)).bindings['chat:A'], { sessionId: 'S1', relay: true, typing: false, retained: { version: 1 } })
  assert.deepEqual(f.api.listBindings(), (await readBindings(f.path)).bindings)
})

test('admission in progress blocks mutation before any relay trigger exists', async t => {
  const f = await bridgeFixture(t, { 'chat:A': { sessionId: 'S1', relay: true, typing: false } })
  let entered, release
  const ready = new Promise(resolve => { entered = resolve })
  const gate = new Promise(resolve => { release = resolve })
  const readText = f.services.fs.readText
  f.services.fs.readText = async path => { if (path === f.path) { entered(); await gate } return readText(path) }
  await f.inbound('A', false); await ready
  const view = await f.api.bindingManagement.list()
  await assert.rejects(f.api.bindingManagement.bind({ chatGuid: 'A', sessionId: 'S2', relay: true, expectedRevision: view.revision }), errorCode('busy'))
  release(); await setImmediate()
  assert.equal((await readBindings(f.path)).bindings['chat:A'].sessionId, 'S1')
})

test('a CLI unbind invalidates a previously armed relay before a late assistant callback', async t => {
  const f = await bridgeFixture(t, { 'chat:A': { sessionId: 'S1', relay: true, typing: false } })
  await f.inbound()
  // The shipped CLI participates in the same canonical file lock but runs in
  // another process and has no access to the host's in-memory trigger table.
  await updateBindings(f.path, undefined, table => { delete table['chat:A'] })
  f.listeners.get('session/event')({ id: 'S1' }, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'late synthetic reply' }] } } })
  await f.api.whenRelayIdle()
  assert.equal(f.sends.length, 0)
})

test('a CLI rebind cannot send the former session response into the newly bound chat', async t => {
  const f = await bridgeFixture(t, { 'chat:A': { sessionId: 'S1', relay: true, typing: false } })
  await f.inbound()
  await updateBindings(f.path, undefined, table => { table['chat:A'].sessionId = 'S2' })
  f.listeners.get('session/event')({ id: 'S1' }, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'stale S1 reply' }] } } })
  await f.api.whenRelayIdle()
  assert.equal(f.sends.length, 0)
})

test('explicit scheduler armRelay preserves its unbound-chat delivery contract', async t => {
  const f = await bridgeFixture(t, {})
  await f.api.armRelay({ sessionId: 'S1', chatGuid: 'A', relay: true, typing: false })
  f.listeners.get('session/event')({ id: 'S1' }, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'scheduled synthetic reply' }] } } })
  await f.api.whenRelayIdle()
  assert.equal(f.sends.length, 1)
  assert.match(f.sends[0], /"chatGuid":"A"/)
})

test('two ordinary assistant messages in one turn both relay instead of competing for the file lease', async t => {
  const f = await bridgeFixture(t, { 'chat:A': { sessionId: 'S1', relay: true, typing: false } })
  await f.inbound()
  for (const text of ['first synthetic reply', 'second synthetic reply']) {
    f.listeners.get('session/event')({ id: 'S1' }, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text }] } } })
  }
  await f.api.whenRelayIdle()
  assert.equal(f.sends.length, 2)
})
