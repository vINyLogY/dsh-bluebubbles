import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile, rename, access, realpath, cp, symlink } from 'node:fs/promises'
import { createServer } from 'node:http'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

// Private copied settings/selection metadata are inputs, not logged and never
// modified. No .env is read. The only endpoint/credential here is synthetic.
let inputs = process.env.DSH_COMPAT_PROFILE_INPUTS
const legacyModules = process.env.DSH_LEGACY_NODE_MODULES
const bindingMetadata = process.env.DSH_COMPAT_BINDING_METADATA
const legacyProfileModules = process.env.DSH_COMPAT_LEGACY_PROFILE_MODULES
const privateInputs = Boolean(inputs)
if (!legacyModules) throw new Error('Require explicit locked legacy oracle path')
const require = createRequire(new URL('../src/index.ts', import.meta.url))
const targetModules = await realpath(resolve(require.resolve('@deepseek-ai/dsh-llm/package.json'), '../../..'))
assert.equal(JSON.parse(await readFile(require.resolve('@deepseek-ai/dsh-llm/package.json'), 'utf8')).version, '0.1.7-rc.2')
const home = await mkdtemp('/tmp/dsh-chatcompat-profile.')
for (const key of Object.keys(process.env)) if (key !== 'PATH') delete process.env[key]
Object.assign(process.env, { HOME: home, DSH_HOME: home, DEEPSEEK_BASE_URL: 'https://offline.invalid/v1' })
const { parse, stringify } = await import(pathToFileURL(join(targetModules, 'yaml/dist/index.js')))
const legacy = await import(pathToFileURL(join(legacyModules, '@deepseek-ai/dsh-llm-deepseek/lib/index.js')))
const oldConnection = legacy.resolveAdapterOptions({})
if (!inputs) {
  inputs = join(home, 'synthetic-inputs')
  await mkdir(inputs, { mode: 0o700 })
  const profile = n => ({ apiKeyEnv: 'SYNTHETIC_KEY', api: 'openai-completions', baseURL: `https://offline.invalid/pi-${n}`, models: [{ id: 'synthetic-b-model', name: 'Synthetic B', contextWindow: 1000000, maxTokens: 1024, input: ['text'], reasoningEfforts: { off: null, low: 'low', high: 'high' } }] })
  const a = { provider: 'synthetic-a', model: oldConnection.models.find(m => m.inputModalities?.includes('image')).id, reasoningEffort: 'high' }
  const b = { provider: 'synthetic-b', model: 'synthetic-b-model', reasoningEffort: 'low' }
  await writeFile(join(inputs, 'settings.yaml'), stringify({ 'agent-default-model': b, 'agent-presets': { default: 'standard' }, 'llm-pi-ai': { providers: { 'synthetic-b': profile(0), 'synthetic-c': profile(1), 'synthetic-d': profile(2) } } }), { mode: 0o600 })
  for (const [i, selection] of [a, b].entries()) await writeFile(join(inputs, `selection-${i}.json`), JSON.stringify({ selection }), { mode: 0o600 })
}
const settingsBytes = await readFile(join(inputs, 'settings.yaml'))
const settings = parse(settingsBytes.toString())
const selections = await Promise.all([0, 1].map(async i => JSON.parse(await readFile(join(inputs, `selection-${i}.json`), 'utf8')).selection))
if (privateInputs && !bindingMetadata) throw new Error('Copied-settings cold bindings require explicit bound-header preset metadata')
const boundPresets = privateInputs ? JSON.parse(await readFile(bindingMetadata, 'utf8')).presets : ['standard', 'standard']
assert.equal(boundPresets.length, 2)
const selectedModel = oldConnection.models.find(m => m.id === selections[0].model)
assert.ok(selectedModel)
const piProfiles = structuredClone(settings['llm-pi-ai'])
assert.equal(Object.hasOwn(piProfiles.providers, selections[0].provider), false, 'A ownership already exists in configured Pi profiles')
const config = { provider: selections[0].provider, baseURL: 'https://offline.invalid/v1', apiKeyEnv: oldConnection.apiKeyEnv, models: oldConnection.models, defaults: oldConnection.defaults, maxTokens: oldConnection.maxTokens, defaultContextWindow: oldConnection.defaultContextWindow }
const patch = [
  { id: 'agent-default-model', config: settings['agent-default-model'] },
  { id: 'agent-preset-registry', config: { default: 'standard', selectedDefault: settings['agent-presets'].default } },
  { id: 'llm-pi-ai', config: piProfiles },
  { id: 'llm-deepseek', disabled: true },
  { id: 'hmr', disabled: true },
  { insert: [{ id: 'private-chat-compat', name: new URL('../src/index.ts', import.meta.url).href, config }] },
]
await mkdir(join(home, 'profiles/web'), { recursive: true, mode: 0o700 })
const bundles = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app']
if (legacyProfileModules) {
  const profileModules = join(home, 'profiles/web/node_modules')
  await mkdir(join(profileModules, '@deepseek-ai'), { recursive: true, mode: 0o700 })
  await mkdir(join(profileModules, '@openai'), { recursive: true, mode: 0o700 })
  await cp(join(legacyProfileModules, '@deepseek-ai/dsh-subagent-codex'), join(profileModules, '@deepseek-ai/dsh-subagent-codex'), { recursive: true })
  await cp(join(legacyProfileModules, '@openai/codex'), join(profileModules, '@openai/codex'), { recursive: true })
  await symlink(targetModules, join(home, 'node_modules'))
  const codexRequire = createRequire(join(profileModules, '@deepseek-ai/dsh-subagent-codex/package.json'))
  assert.equal(await realpath(codexRequire.resolve('@deepseek-ai/dsh-session')), await realpath(require.resolve('@deepseek-ai/dsh-session')))
  bundles.push('@deepseek-ai/dsh-subagent-codex')
}
await writeFile(join(home, 'profiles/web/package.json'), JSON.stringify({ name: 'synthetic-compat-profile', private: true, dsh: { profile: { bundles } } }), { mode: 0o600 })
// Normal loader reference, without inspecting or changing a credential file.
const patchText = stringify(patch).replace('baseURL: https://offline.invalid/v1', 'baseURL: !!js "ctx.get(\'launchEnvironment\').get(\'DEEPSEEK_BASE_URL\').value"')
await writeFile(join(home, 'profiles/web/cordis.patch.yml'), patchText, { mode: 0o600 })
await writeFile(join(home, 'settings.yaml'), settingsBytes, { mode: 0o600 })
await rename(join(home, 'settings.yaml'), join(home, 'settings.yaml.pre-017-preserved'))
let networkAttempts = 0
globalThis.fetch = async () => { networkAttempts++; throw new Error('profile startup network prohibited') }
const { runProfile } = await import(pathToFileURL(join(targetModules, '@deepseek-ai/dsh/lib/profile-boot.js')))
const { createLaunchEnvironmentSnapshot } = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-launch-environment')))
const original = Object.fromEntries(['log', 'warn', 'error', 'info', 'debug'].map(k => [k, console[k]]))
const privateLogs = []
for (const k of Object.keys(original)) console[k] = (...args) => privateLogs.push(args.map(String).join(' '))
let boot
let failed = false
let coldBindingsPassed = false
async function coldBindings(ctx) {
  const bridge = (await import('../../../src/index.ts')).default
  const { Session, SESSION_FORMAT_VERSION } = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-session')))
  const ids = ['synthetic-binding-A', 'synthetic-binding-B']
  const workspace = join(home, 'synthetic-workspace')
  await mkdir(workspace, { recursive: true, mode: 0o700 })
  for (const [i, id] of ids.entries()) {
    const header = { version: SESSION_FORMAT_VERSION, id, createdAt: 1700000000000, cwd: workspace, isSeeded: false, agentPreset: boundPresets[i] }
    const session = Session.create(id, [], header)
    session.append('turn/start', { turn: 1 })
    session.append('step/start', { turn: 1, step: 1 })
    session.append('request/header', { header: { config: selections[i] }, reason: 'initial' })
    session.append('step/end', { turn: 1, step: 1 })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    const handle = await ctx.sessionPersistence.create(header)
    try { await handle.append(session.snapshotEvents()); await handle.flush() } finally { await handle.close() }
  }
  await writeFile(join(home, 'bluebubbles-bindings.json'), JSON.stringify({ 'chat:synthetic-chat-A': { sessionId: ids[0], relay: true }, 'chat:synthetic-chat-B': { sessionId: ids[1], relay: true } }), { mode: 0o600 })
  let webhook
  const sends = [], modelRequests = []
  const server = createServer(async (req, res) => {
    if (req.url === '/bluebubbles/webhook') return webhook(req, res)
    let body = ''; for await (const chunk of req) body += chunk
    if (req.url.startsWith('/api/v1/message/text?')) sends.push(JSON.parse(body))
    const data = req.url.startsWith('/api/v1/webhook?') ? [{ id: 1, url: 'http://127.0.0.1:3080/bluebubbles/webhook' }] : {}
    res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ status: 200, data }))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const url = `http://127.0.0.1:${server.address().port}`
  Object.assign(process.env, { BLUEBUBBLES_BASE_URL: url, BLUEBUBBLES_PASSWORD: 'synthetic', BLUEBUBBLES_GUARD: '1', BLUEBUBBLES_GUARD_APPROVAL: 'reject' })
  const register = ctx.webServer.register.bind(ctx.webServer)
  ctx.webServer.register = route => { if (route.path === '/bluebubbles/webhook') { webhook = route.handler; return () => {} }; return register(route) }
  const previousFetch = globalThis.fetch
  // BlueBubbles uses the public shell boundary. Do not execute curl or loosen
  // a sandbox policy just to test the bridge on this machine.
  const shellExecute = ctx.shell.execute.bind(ctx.shell)
  ctx.shell.execute = async spec => {
    assert.ok(spec.command.startsWith('curl '), 'fixture refuses unrelated shell execution')
    let data = {}
    if (spec.command.includes('/api/v1/webhook?')) data = [{ id: 1, url: 'http://127.0.0.1:3080/bluebubbles/webhook' }]
    if (spec.command.includes('/api/v1/message/text?')) {
      const body = /--data-raw '([^']*)'/u.exec(spec.command)?.[1]
      assert.ok(body)
      sends.push(JSON.parse(body))
    }
    return { result: async () => ({ exitCode: 0, stdout: { text: JSON.stringify({ status: 200, data }) }, stderr: { text: '' }, timedOut: false }) }
  }
  const localFetch = (await import('node:module')).createRequire(import.meta.url)('node:http')
  // Independent loopback HTTP helper; fetch remains a provider-only stub.
  async function deliver(index) {
    const payload = JSON.stringify({ type: 'new-message', data: { guid: `synthetic-in-${index}`, text: `cold-input-${index}`, chats: [{ guid: index ? 'synthetic-chat-B' : 'synthetic-chat-A' }], handle: { address: `synthetic-sender-${index}` } } })
    await new Promise((resolve, reject) => { const req = localFetch.request(url + '/bluebubbles/webhook', { method: 'POST', headers: { 'content-type': 'application/json' } }, res => { res.resume(); res.on('end', () => res.statusCode === 200 ? resolve() : reject(new Error('synthetic webhook rejected'))) }); req.on('error', reject); req.end(payload) })
  }
  globalThis.fetch = async (_url, spec) => {
    const body = JSON.parse(spec.body)
    modelRequests.push(body)
    const frame = { id: 'synthetic-response', choices: [{ index: 0, delta: { content: 'synthetic reply' }, finish_reason: 'stop' }] }
    return new Response('data: ' + JSON.stringify(frame) + '\n\ndata: [DONE]\n\n')
  }
  ctx.credentials.resolve = async () => ({ value: 'synthetic-key' })
  let bridgeFiber
  async function until(check, description) { for (let i = 0; i < 500; i++) { if (check()) return; await new Promise(r => setTimeout(r, 10)) }; throw new Error(description) }
  try {
    bridgeFiber = ctx.plugin(bridge); await bridgeFiber
    await until(() => webhook && Object.keys(ctx.bluebubbles.listBindings()).length === 2, 'synthetic bindings did not load')
    for (const [i, id] of ids.entries()) {
      assert.equal(ctx.agents.get(id), undefined)
      await deliver(i)
      await until(() => (ctx.agents.get(id)?.session.snapshotEvents().filter(e => e.type === 'turn/end').length ?? 0) > 1, 'synthetic cold turn did not settle')
      await ctx.agents.get(id).whenIdle()
      assert.deepEqual(ctx.agents.get(id).session.snapshotEvents().findLast(e => e.type === 'turn/end').data.reason, { kind: 'completed' })
      assert.equal(ctx.agents.get(id).options.provider, selections[i].provider)
      assert.equal(ctx.agents.get(id).options.model, selections[i].model)
      assert.equal(ctx.agents.get(id).options.reasoningEffort, selections[i].reasoningEffort)
    }
    await until(() => sends.length === 2, 'synthetic replies did not remain scoped')
    assert.deepEqual(sends.map(s => s.chatGuid), ['synthetic-chat-A', 'synthetic-chat-B'])
    assert.deepEqual(modelRequests.map(r => r.model), selections.map(s => s.model))
    coldBindingsPassed = true
  } finally {
    if (bridgeFiber) await bridgeFiber.dispose()
    ctx.webServer.register = register
    ctx.shell.execute = shellExecute
    globalThis.fetch = previousFetch
    await new Promise(resolve => server.close(resolve))
    for (const name of ['BLUEBUBBLES_BASE_URL', 'BLUEBUBBLES_PASSWORD', 'BLUEBUBBLES_GUARD', 'BLUEBUBBLES_GUARD_APPROVAL']) delete process.env[name]
  }
}
try {
  for (let repeat = 0; repeat < 2; repeat++) {
    boot = await runProfile({ environment: createLaunchEnvironmentSnapshot([{ source: 'process', values: { ...process.env } }]), profile: 'web', patchFiles: [], args: ['--no-open', '--port', '0'] })
    const providers = boot.ctx.llm.listProviders()
    assert.equal(providers.filter(p => p.id === selections[0].provider).length, 1)
    for (const provider of Object.keys(piProfiles.providers)) assert.equal(providers.filter(p => p.id === provider).length, 1)
    for (const selection of selections) {
      assert.ok((await boot.ctx.llm.listModels(selection.provider)).some(m => m.id === selection.model))
      const model = await boot.ctx.llm.resolveModelInfo(selection.provider, selection.model)
      if (selection.reasoningEffort !== undefined) assert.ok(model.reasoning.efforts.some(e => e.id === selection.reasoningEffort))
    }
    assert.deepEqual(boot.ctx.agentDefaultModel.currentSelection(), settings['agent-default-model'])
    assert.equal(boot.ctx.agentPresets.defaultId, settings['agent-presets'].default)
    for (const preset of boundPresets) assert.equal((await boot.ctx.agentPresets.resolve(preset)).id, preset)
    if (legacyProfileModules) assert.ok(boot.ctx.subagents.getProvider('codex'))
    assert.equal(networkAttempts, 0)
    if (repeat === 0) await coldBindings(boot.ctx)
    await boot.shutdown.shutdown(0)
    boot = undefined
  }
  await assert.rejects(access(join(home, 'settings.yaml')))
  assert.deepEqual(await readFile(join(home, 'settings.yaml.pre-017-preserved')), settingsBytes)
  original.log(JSON.stringify({ pass: true, stage: home, targetVersion: '0.1.7-rc.2', bothExactModelsAndEfforts: true, aProviderOwnedOnce: true, existingPiProfilesRetained: Object.keys(piProfiles.providers).length, savedDefaultsRetained: true, boundExplicitPresetsPreserved: true, existingCodexRegistration: Boolean(legacyProfileModules), codexExecutions: 0, repeatBootRetained: true, originalSettingsBytesRetained: true, normalEndpointReferenceResolved: true, bothBindingsColdResumed: coldBindingsPassed, syntheticRepliesScoped: coldBindingsPassed, upstreamModelCalls: 0, realMessages: 0 }))
} catch (e) {
  failed = true
  await writeFile(join(home, 'private-logs.txt'), privateLogs.join('\n'), { mode: 0o600 })
  await writeFile(join(home, 'private-error.txt'), e.stack ?? String(e), { mode: 0o600 })
  original.log(JSON.stringify({ pass: false, stage: home, errorType: e.name }))
  process.exitCode = 1
} finally {
  if (boot) await boot.shutdown.shutdown(0)
  for (const [k, value] of Object.entries(original)) console[k] = value
  if (failed) process.exitCode = 1
}
