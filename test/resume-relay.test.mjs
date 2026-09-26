import assert from 'node:assert/strict'
import test from 'node:test'
import bridge from '../src/index.ts'
import { ensureLiveAgent } from '../src/lib.ts'

function resumeFixture(id, events, fallback) {
  const calls = []
  const mounts = []
  const agent = { id }
  const services = {
    sessionPersistence: {
      async list() { return [{ id }] },
      async inspect() { return { meta: { id, agentPreset: 'stored-preset' }, events } },
    },
    agentPresets: {
      async resolve(preset) { return { id: preset } },
      async mount(context, preset) { mounts.push(preset) },
    },
    agentDefaultModel: { currentSelection() { return fallback } },
  }
  const agents = {
    get() {},
    async resume(options) {
      calls.push(options)
      await options.setup({})
      return { agent }
    },
  }
  return { ctx: { get(name) { return services[name] } }, agents, agent, calls, mounts }
}

test('cold resume restores the latest valid request selection and output limit', async () => {
  const fixture = resumeFixture('persisted-model', [
    { type: 'request/header', data: { header: { config: { provider: 'old', model: 'old' } } } },
    { type: 'agent-preset/selected', data: { agentPreset: 'selected-preset' } },
    { type: 'request/header', data: { header: { config: { provider: 'session-provider', model: 'session-model', maxTokens: 4096 } } } },
    { type: 'request/header', data: { header: { config: { provider: '', model: '' } } } },
  ], { provider: 'deployment-provider', model: 'deployment-model' })
  assert.equal(await ensureLiveAgent(fixture.ctx, fixture.agents, fixture.agent.id), fixture.agent)
  assert.deepEqual(fixture.calls[0].agentOptions, { provider: 'session-provider', model: 'session-model', maxTokens: 4096 })
  assert.deepEqual(fixture.mounts, ['selected-preset'])
})

test('header-only cold sessions use the deployment default model', async () => {
  const fixture = resumeFixture('default-model', [], { provider: 'deployment-provider', model: 'deployment-model' })
  assert.equal(await ensureLiveAgent(fixture.ctx, fixture.agents, fixture.agent.id), fixture.agent)
  assert.deepEqual(fixture.calls[0].agentOptions, { provider: 'deployment-provider', model: 'deployment-model' })
  assert.deepEqual(fixture.mounts, ['stored-preset'])
})

test('resume skips incomplete selections and ignores invalid token limits', async () => {
  const absent = resumeFixture('no-model', [], { provider: 'deployment-provider' })
  assert.equal(await ensureLiveAgent(absent.ctx, absent.agents, absent.agent.id), undefined)
  assert.equal(absent.calls.length, 0)
  const invalid = resumeFixture('invalid-limit', [
    { type: 'request/header', data: { header: { config: { provider: 'p', model: 'm', maxTokens: -1 } } } },
  ])
  await ensureLiveAgent(invalid.ctx, invalid.agents, invalid.agent.id)
  assert.deepEqual(invalid.calls[0].agentOptions, { provider: 'p', model: 'm' })
})

// The real plugin registers its normal listeners and service. Its filesystem,
// shell and tool transports are in-memory: no command or HTTP request executes.
async function relayFixture(t, storedTriggers = {}) {
  const home = '/synthetic-dsh-test'
  const env = {
    DSH_HOME: home,
    BLUEBUBBLES_PASSWORD: '',
    BLUEBUBBLES_DEBUG: '0',
    BLUEBUBBLES_BINDINGS: home + '/bindings.json',
    BLUEBUBBLES_CONTACTS: home + '/contacts.json',
    BLUEBUBBLES_RELAY_STATE: home + '/relay.json',
    BLUEBUBBLES_GUARD: '0',
  }
  const before = Object.fromEntries(Object.keys(env).map(name => [name, process.env[name]]))
  Object.assign(process.env, env)
  const realNow = Date.now
  let now = 1700000000000
  Date.now = () => now
  t.after(() => {
    Date.now = realNow
    for (const [name, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  })
  const files = new Map([[env.BLUEBUBBLES_RELAY_STATE, JSON.stringify(storedTriggers)]])
  const listeners = new Map()
  const sends = []
  const shell = {
    resolve(spec) { return spec },
    async run(spec) {
      if (spec.command.includes('/message/text?')) sends.push(spec.command)
      if (spec.command.startsWith('cat ')) return { exitCode: 1, stdout: { text: '' } }
      return { exitCode: 0, stdout: { text: '{"status":200,"data":{}}' } }
    },
  }
  const fs = {
    async resolve(path) { return path },
    async readText(path) {
      if (!files.has(path)) throw new Error('ENOENT')
      return files.get(path)
    },
    async writeText(path, text) { files.set(path, text) },
  }
  let service
  const ctx = {
    shell,
    tools: { register() { return () => {} } },
    get(name) { return { shell, fs }[name] },
    on(name, fn) { listeners.set(name, fn) },
    effect(fn) { return fn() },
    provide(name, value) { if (name === 'bluebubbles') service = value },
  }
  bridge.apply(ctx)
  const settle = () => new Promise(resolve => setImmediate(resolve))
  await settle() // bootstrap reads stored triggers before a test arms new ones
  const event = (type, data, sessionId = 'session') => listeners.get('session/event')({ id: sessionId }, { type, data })
  return {
    sends, files, settle, event,
    advance(ms) { now += ms },
    arm: () => service.armRelay({ sessionId: 'session', chatGuid: 'chat', typing: false }),
    text(text, turn = 1) { event('assistant/message', { turn, step: 1, message: { content: [{ type: 'text', text }] } }) },
  }
}

test('an errored turn cannot relay the next web-originated turn', async t => {
  const fixture = await relayFixture(t)
  await fixture.arm()
  fixture.event('turn/start', { turn: 1 })
  fixture.text('progress before a later step fails')
  fixture.event('turn/end', { turn: 1, reason: { kind: 'error' } })
  fixture.event('turn/start', { turn: 2 })
  fixture.event('user/message', { id: 'web-input', role: 'user', content: [{ type: 'text', text: 'private web follow-up' }], source: { kind: 'user' } })
  fixture.text('private web response', 2)
  fixture.event('turn/end', { turn: 2, reason: { kind: 'completed' } })
  await fixture.settle()
  assert.equal(fixture.sends.length, 1)
  assert.ok(fixture.sends[0].includes('progress before a later step fails'))
  assert.deepEqual(JSON.parse(fixture.files.get('/synthetic-dsh-test/relay.json')), {})
})

test('a zero-reply error also requires explicit re-arming before retry', async t => {
  const fixture = await relayFixture(t)
  await fixture.arm()
  fixture.event('turn/end', { turn: 1, reason: { kind: 'error' } })
  fixture.text('unrelated reply', 2)
  await fixture.settle()
  assert.equal(fixture.sends.length, 0)
  await fixture.arm()
  fixture.event('turn/start', { turn: 3 })
  fixture.text('explicitly retried reply', 3)
  await fixture.settle()
  assert.equal(fixture.sends.length, 1)
})

test('an active turn still relays its final answer after ten minutes', async t => {
  const fixture = await relayFixture(t)
  await fixture.arm()
  fixture.event('turn/start', { turn: 1 })
  fixture.advance(11 * 60 * 1000)
  fixture.event('step/start', { turn: 1, step: 2 })
  fixture.text('long-task final answer')
  fixture.event('turn/end', { turn: 1, reason: { kind: 'completed' } })
  fixture.text('later unrelated answer', 2)
  await fixture.settle()
  assert.equal(fixture.sends.length, 1)
  assert.ok(fixture.sends[0].includes('long-task final answer'))
})

test('an idle trigger expires when a new turn starts after ten minutes', async t => {
  const fixture = await relayFixture(t)
  await fixture.arm()
  fixture.advance(11 * 60 * 1000)
  fixture.event('turn/start', { turn: 1 })
  fixture.text('late unrelated answer')
  await fixture.settle()
  assert.equal(fixture.sends.length, 0)
})

test('startup rejects old persisted triggers and NO_REPLY clears fresh ones', async t => {
  const fixture = await relayFixture(t, {
    session: { chatGuid: 'chat', relay: true, typing: false, setAt: 1700000000000 - 11 * 60 * 1000 },
  })
  fixture.text('reply with stale startup trigger')
  await fixture.settle()
  assert.equal(fixture.sends.length, 0)
  await fixture.arm()
  fixture.text(' NO_REPLY ')
  fixture.text('suppressed later text')
  await fixture.settle()
  assert.equal(fixture.sends.length, 0)
})
