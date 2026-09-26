import assert from 'node:assert/strict'
import test from 'node:test'
import { createServer } from 'node:http'
import { mkdir, mkdtemp, readFile, writeFile, realpath, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { zstdCompressSync } from 'node:zlib'
import bridge from '../../src/index.ts'
import { resolveSession } from '../../src/lib.ts'

// Run with a real source checkout whose node_modules is the selected locked
// cohort. Source and driver must resolve the exact same physical dependencies.
const require = createRequire(import.meta.url)
const sourceRequire = createRequire(new URL('../../src/lib.ts', import.meta.url))
const cohort = process.env.DSH_RUNTIME_NODE_MODULES
assert.ok(cohort, 'DSH_RUNTIME_NODE_MODULES must identify the installed cohort')
const cohortRoot = await realpath(cohort)
async function version(name) {
  const spec = '@deepseek-ai/' + name
  const exported = name === 'dsh' ? spec + '/lib/bin.js' : spec
  const entry = await realpath(require.resolve(exported))
  assert.equal(entry, await realpath(sourceRequire.resolve(exported)), spec + ' resolves differently from src')
  assert.ok(entry.startsWith(cohortRoot + '/'), spec + ' escaped the selected cohort')
  const metadata = JSON.parse(await readFile(join(dirname(entry), '..', 'package.json'), 'utf8'))
  console.log(`runtime: ${spec}@${metadata.version} ${entry}`)
  return metadata.version
}
const agentVersion = await version('dsh-agent')
const modern = agentVersion === '0.1.7-rc.2'
assert.ok(modern || agentVersion === '0.1.1-rc.2', 'unsupported test cohort')
assert.equal(process.env.DSH_RUNTIME_COHORT, modern ? 'next' : 'legacy', 'cohort label must match the source-resolved runtime')
assert.equal(await version('dsh'), modern ? '0.1.7-rc.2' : '0.1.1-rc.1')
for (const name of ['dsh-agent-loop', 'dsh-session', 'dsh-session-persistence-jsonl', 'dsh-tools']) {
  assert.equal(await version(name), modern ? '0.1.7-rc.2' : '0.1.1-rc.2')
}
assert.equal(await version('dsh-shell'), modern ? '0.1.7-rc.2' : '0.1.1-rc.1')
await version('cordis')
const eventsOf = session => session ? (typeof session.snapshotEvents === 'function' ? session.snapshotEvents() : session.events) : []
const pkg = name => import('@deepseek-ai/' + name)
const { Context } = await pkg('cordis')
const { default: SessionStore } = await pkg('dsh-session')
const { default: Persistence } = await pkg('dsh-session-persistence-jsonl')
const { default: Agents, installModelSelection } = await pkg('dsh-agent')
const { default: AgentLoop } = await pkg('dsh-agent-loop')
const { default: Llm, LlmAdapter } = await pkg('dsh-llm')
const { default: Prompt } = await pkg('dsh-system-prompt')
const { default: Tools } = await pkg('dsh-tools')
const { default: Projections } = await pkg('dsh-session-projection')
const { default: Presets } = await pkg(modern ? 'dsh-agent-preset-registry' : 'dsh-agent-presets')
const { Loader } = await pkg('cordis-plugin-loader')
const { default: Fs } = await pkg('dsh-fs-local')
const { default: Subprocess } = await pkg('dsh-subprocess-local')
const { default: Bash } = await pkg('dsh-bash-local')
const { default: Defaults } = await pkg('dsh-agent-default-model')
const { default: Approval } = await pkg('dsh-user-approval')
const CheckpointPolicy = await pkg('dsh-session-checkpoint-policy')
if (modern) {
  const { evaluatePluginCompatibility } = await pkg('dsh-app-boot')
  const manifest = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8'))
  for (const supported of ['0.1.1-rc.1', '0.1.1-rc.2', '0.1.7-rc.2']) {
    assert.equal(evaluatePluginCompatibility(manifest, {}, supported), undefined)
  }
  for (const unsupported of ['0.1.5-rc.3', '0.1.7-rc.3']) {
    assert.ok(evaluatePluginCompatibility(manifest, {}, unsupported), 'untested host must fail the compatibility gate')
  }
}

test('real runtime cold-resumes two fixed bindings and keeps replies and guards scoped', { timeout: 60000 }, async t => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-bb-runtime-'))
  const cwd = join(home, 'workspace')
  const root = join(home, 'sessions')
  await mkdir(cwd, { recursive: true })
  await mkdir(root)
  const environment = { ...process.env }
  // Prevent inherited per-file paths, credentials and plugin settings from
  // touching live state, including the shell's fallback HOME reads.
  for (const name of Object.keys(process.env)) if (name !== 'PATH') delete process.env[name]
  Object.assign(process.env, { HOME: home, DSH_HOME: home, BLUEBUBBLES_PASSWORD: 'synthetic', BLUEBUBBLES_GUARD: '1', BLUEBUBBLES_GUARD_APPROVAL: 'reject' })
  t.after(() => {
    for (const name of Object.keys(process.env)) delete process.env[name]
    Object.assign(process.env, environment)
  })
  const ids = ['fixture-session-A', 'fixture-session-B']
  await writeFile(join(home, 'bluebubbles-bindings.json'), JSON.stringify({
    'chat:chat-A': { sessionId: ids[0], relay: true },
    'chat:chat-B': { sessionId: ids[1], relay: true },
  }))
  const sends = []
  let webhook
  const server = createServer(async (req, res) => {
    if (req.url === '/bluebubbles/webhook') return webhook(req, res)
    let raw = ''
    for await (const chunk of req) raw += chunk
    let data = {}
    if (req.url.startsWith('/api/v1/message/text?')) sends.push(JSON.parse(raw))
    else if (req.url.startsWith('/api/v1/message/old-parent?')) data = { guid: 'old-parent', text: 'older quoted context', handle: { address: 'parent-sender' } }
    else if (req.url.startsWith('/api/v1/webhook?')) data = [{ id: 1, url: 'http://127.0.0.1:3080/bluebubbles/webhook' }]
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ status: 200, data }))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const url = `http://127.0.0.1:${server.address().port}`
  process.env.BLUEBUBBLES_BASE_URL = url
  const ctx = new Context()
  const fibers = []
  t.after(async () => {
    for (const fiber of fibers.reverse()) await fiber.dispose()
    await new Promise(resolve => server.close(resolve))
  })
  async function mount(plugin, config) { const fiber = ctx.plugin(plugin, config); fibers.push(fiber); await fiber }
  const settle = () => new Promise(resolve => setImmediate(resolve))
  async function until(predicate, label) {
    for (let attempt = 0; attempt < 500; attempt++) {
      if (predicate()) return
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    assert.fail(label)
  }
  await mount(Loader, { baseUrl: new URL('./', import.meta.url).href })
  await mount(SessionStore)
  await mount(Projections)
  await mount(Persistence, { root, compression: 'zstd' })
  const originals = new Map()
  for (const id of ids) {
    const header = { type: 'session', version: 0, id, createdAt: 1700000000000, cwd, delegationDepth: 0, agentPreset: 'fixture-preset' }
    const directory = dirname(ctx.sessionPersistence.locate(header).path)
    await mkdir(directory, { recursive: true })
    const path = join(directory, 'session.jsonl.zstd')
    const bytes = zstdCompressSync(Buffer.from(JSON.stringify(header) + '\n'))
    await writeFile(path, bytes)
    originals.set(path, bytes)
  }
  await mount(Agents)
  await mount(Prompt, { includeHarnessIdentity: false })
  await mount(Tools)
  await mount(Llm)
  await mount(Subprocess)
  await mount(Bash, { cwd })
  await mount(Fs)
  await mount(Defaults, { provider: 'fixture-provider', model: 'fixture-model', ...modern ? { reasoningEffort: 'high' } : {} })
  if (modern) {
    await mount(Presets, { default: 'fixture-preset' })
    await ctx.agentPresets.register({ id: 'fixture-preset', plugins: [{ name: new URL('./preset-plugin.mjs', import.meta.url).href }] })
  } else {
    const presetRoot = join(home, 'presets')
    await mkdir(join(presetRoot, 'fixture-preset'), { recursive: true })
    await writeFile(join(presetRoot, 'fixture-preset', 'agent.cordis.yml'), '- name: ' + JSON.stringify(new URL('./preset-plugin.mjs', import.meta.url).href) + '\n')
    await mount(Presets, { default: 'fixture-preset', includeUserRoot: false, roots: [{ path: presetRoot, trust: 'system' }] })
  }
  await mount(AgentLoop)
  // Match the shipped profile's durability boundary. Without this service,
  // an invalid source can look successful in memory but fail before a real
  // provider request when the production profile validates its checkpoint.
  await mount(CheckpointPolicy)
  await mount(Approval, { policy: 'ask' })
  const requests = []
  const toolInputs = new Set()
  class FakeAdapter extends LlmAdapter {
    async resolveModel(provider, model) {
      return { provider, id: model, name: model, reasoning: { efforts: [{ id: 'high', name: 'High' }, { id: 'low', name: 'Low' }] } }
    }
    async *stream(options) {
      requests.push(options)
      const input = options.messages.findLast(message => message.role === 'user' && (message.source?.kind === 'user' || message.source?.plugin === 'dsh-bluebubbles' || message.source?.kind === 'plugin:dsh-bluebubbles'))
      assert.ok(input, 'provider request has no user or bridge input')
      const body = input.content.filter(part => part.type === 'text').map(part => part.text).join(' ')
      if (body.includes('fail-next')) throw new Error('synthetic provider error')
      if (body.startsWith('approval-') && !toolInputs.has(input.id)) {
        toolInputs.add(input.id)
        const id = 'approval-call-' + input.id
        yield { type: 'block-start', index: 0, blockType: 'tool-call' }
        yield { type: 'tool-call-delta', index: 0, id, name: 'synthetic_approval', argumentsDelta: '{}' }
        yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: 'synthetic_approval', arguments: '{}' } }
        yield { type: 'finish', reason: { kind: 'tool-calls' } }
        return
      }
      const text = 'reply:' + body
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text }
      yield { type: 'block-end', index: 0, block: { type: 'text', text } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
  ctx.llm.registerAdapter(['fixture-provider', 'switched-provider'], new FakeAdapter())
  await mount({ apply(child) {
    child.provide('webServer', { register(route) { webhook = route.handler; return () => {} } })
    child.provide('workspaceRegistry', { async resolveByPath(path) { assert.equal(path, cwd); return { sessionIds: ids } } })
  } })
  await mount(bridge)
  await until(() => webhook && Object.keys(ctx.bluebubbles.listBindings()).length === 2, 'bridge bootstrap did not load both bindings')
  let inbound = 0
  async function deliver(index, text, extra = {}) {
    const id = ids[index]
    const before = eventsOf(ctx.agents.get(id)?.session).filter(event => event.type === 'turn/end').length
    const response = await fetch(url + '/bluebubbles/webhook', { method: 'POST', body: JSON.stringify({ type: 'new-message', data: { guid: `inbound-${++inbound}`, text, chats: [{ guid: index === 0 ? 'chat-A' : 'chat-B' }], handle: { address: `sender-${index}` }, ...extra } }) })
    assert.equal(response.status, 200)
    await until(() => eventsOf(ctx.agents.get(id)?.session).filter(event => event.type === 'turn/end').length > before, 'inbound did not finish a turn')
    await ctx.agents.get(id).whenIdle()
    if (!text.includes('fail-next')) {
      assert.deepEqual(eventsOf(ctx.agents.get(id).session).findLast(event => event.type === 'turn/end').data.reason, { kind: 'completed' })
    }
  }
  for (const [index, id] of ids.entries()) {
    assert.equal(ctx.agents.get(id), undefined)
    await deliver(index, `cold-message-${index}`)
    assert.equal(ctx.agents.get(id).id, id)
    assert.equal(ctx.agents.get(id).options.provider, 'fixture-provider')
    assert.equal(ctx.agents.get(id).options.model, 'fixture-model')
  }
  await until(() => sends.length === 2, 'cold replies were not relayed')
  assert.equal(sends[0].chatGuid, 'chat-A')
  assert.ok(sends[0].message.includes('cold-message-0'))
  assert.equal(sends[1].chatGuid, 'chat-B')
  assert.ok(sends[1].message.includes('cold-message-1'))
  if (modern) assert.ok(requests.slice(0, 2).every(request => request.reasoningEffort === 'high'))
  assert.equal(await resolveSession(ctx.workspaceRegistry, { workspacePath: cwd }), ids[0])
  assert.equal(await resolveSession(ctx.workspaceRegistry, { workspacePath: cwd, sessionId: ids[1] }), ids[1])
  for (const [path, bytes] of originals) {
    const stored = await readFile(path)
    assert.deepEqual(modern ? stored : stored.subarray(0, bytes.length), bytes)
    if (modern) assert.ok((await readdir(dirname(path))).includes('session.v4.jsonl.zstd'))
    assert.equal(ctx.agents.get(path.includes(ids[0]) ? ids[0] : ids[1]).session.header.agentPreset, 'fixture-preset')
  }
  await deliver(1, 'quoted-follow-up', { replyToGuid: 'old-parent' })
  await until(() => sends.length === 3, 'quoted reply was not relayed')
  assert.ok(sends[2].message.includes('older quoted context'))
  // A model failure must retire the relay before a subsequent web turn.
  await deliver(0, 'fail-next')
  const first = ctx.agents.get(ids[0])
  const selection = { current: { provider: 'switched-provider', model: 'switched-model', reasoningEffort: 'low' }, assembled: undefined }
  installModelSelection(first.ctx, selection)
  first.send({ id: 'web-switch', role: 'user', content: [{ type: 'text', text: 'web follow-up' }], source: { kind: 'user' } }, 'next-turn', true)
  await first.whenIdle()
  assert.equal(requests.at(-1).provider, 'switched-provider')
  assert.equal(requests.at(-1).model, 'switched-model')
  assert.equal(requests.at(-1).reasoningEffort, 'low')
  selection.current = { provider: 'switched-provider', model: 'switched-model' }
  first.send({ id: 'web-reset', role: 'user', content: [{ type: 'text', text: 'web effort reset' }], source: { kind: 'user' } }, 'next-turn', true)
  await first.whenIdle()
  assert.equal(requests.at(-1).reasoningEffort, undefined)
  await settle()
  assert.equal(sends.length, 3)
  // Exercise the actual tool and approval waterfalls, including an owned child.
  let asks = 0
  ctx.tools.register({ name: 'ask_user_question', description: 'Synthetic ask', parameters: { type: 'object', properties: {} }, output: { schema: { type: 'object' }, render: () => [{ type: 'text', text: '{}' }] }, async execute() { asks++; return {} } })
  const child = await first.ctx.agents.create({ sessionId: 'fixture-child', parentAgent: first, meta: { origin: 'subagent', parentSession: first.id }, agentOptions: { provider: 'fixture-provider', model: 'fixture-model' } })
  const outside = await ctx.agents.create({ sessionId: 'fixture-outside', agentOptions: { provider: 'fixture-provider', model: 'fixture-model' } })
  ctx.on('approval/request', async () => 'allowed-once')
  const approvals = new Map()
  ctx.tools.register({ name: 'synthetic_approval', description: 'Synthetic approval', parameters: { type: 'object', properties: {} }, output: { schema: { type: 'object' }, render: () => [{ type: 'text', text: '{}' }] }, async execute(_args, exec) {
    const outcome = await ctx.approval.request({ agent: exec.agent, toolName: 'synthetic', reason: 'test only' })
    approvals.set(exec.agent.id, outcome)
    return { outcome }
  } })
  async function askApproval(agent) {
    agent.send({ id: 'approval-input-' + agent.id, role: 'user', content: [{ type: 'text', text: 'approval-' + agent.id }], source: { kind: 'user' } }, 'next-turn', true)
    await agent.whenIdle()
    assert.ok(approvals.has(agent.id), 'actual approval tool did not run')
    return approvals.get(agent.id)
  }
  for (const agent of [first, ctx.agents.get(ids[1]), child.agent]) {
    await ctx.tools.execute({ callId: `ask-${agent.id}`, name: 'ask_user_question', arguments: {}, agent, signal: new AbortController().signal })
    assert.equal(asks, 0)
    assert.equal(await askApproval(agent), 'rejected')
  }
  await ctx.tools.execute({ callId: 'ask-outside', name: 'ask_user_question', arguments: {}, agent: outside.agent, signal: new AbortController().signal })
  assert.equal(asks, 1)
  assert.equal(await askApproval(outside.agent), 'allowed-once')
  await child.dispose()
  await outside.dispose()
  console.log(`runtime: PASS ${agentVersion}; cold routes, migration, quoting, model switches and real guard waterfalls; DSH_HOME=${home}`)
})
