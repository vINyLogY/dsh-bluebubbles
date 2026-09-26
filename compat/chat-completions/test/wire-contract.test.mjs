import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { realpath, readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

// Two real, separately resolved cohorts: the old adapter is an oracle only.
// No old dependency is reachable from the adapter-under-test's source imports.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const legacyModules = process.env.DSH_LEGACY_NODE_MODULES
if (!legacyModules) throw new Error('Set DSH_LEGACY_NODE_MODULES to the locked legacy fixture node_modules')
const legacy = await import(pathToFileURL(resolve(legacyModules, '@deepseek-ai/dsh-llm-deepseek/lib/index.js')))
const { ChatCompletionsCompatAdapter } = await import('../src/adapter.ts')
const sourceRequire = createRequire(new URL('../src/adapter.ts', import.meta.url))
const corePath = sourceRequire.resolve('@deepseek-ai/dsh-llm/package.json')
const core = JSON.parse(await readFile(corePath, 'utf8'))
const target = await import(pathToFileURL(sourceRequire.resolve('@deepseek-ai/dsh-llm')))
const provider = 'synthetic-compat'
const model = 'synthetic-vision'
const catalog = [{ id: model, name: 'Synthetic vision', contextWindow: 8192, maxTokens: 1024, inputModalities: ['text', 'image'], imagePixelBudget: 1048576, imageMaxBytes: 4096 }]
const connection = legacy.resolveAdapterOptions({ baseURL: 'https://offline.invalid/v1', apiKeyEnv: 'SYNTHETIC_KEY', models: catalog, thinking: 'enabled', reasoningEffort: 'high' })
// Retry policy is a host-schema input, not a wire field. Do not feed the old
// resolved internal policy object into the new public config validator.
const { retryPolicy: _legacyResolvedRetryPolicy, ...wireConnection } = connection
const config = { ...wireConnection, provider }
const tools = [{ name: 'synthetic_tool', description: 'A synthetic tool', parameters: { type: 'object', properties: { value: { type: 'number' } }, required: ['value'] } }]
const user = { id: 'u', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'synthetic input' }] }
const modelSource = { kind: 'model', provider, model }
function options(messages = [user], extra = {}) { return { provider, model, system: 'synthetic system', reasoningEffort: 'high', maxTokens: 100, messages, tools: [], signal: new AbortController().signal, ...extra } }
function frame(delta, finish_reason = null) { return { id: 'response', choices: [{ index: 0, delta, finish_reason }] } }
function response(frames = [frame({ content: 'reply' }), frame({}, 'stop')], done = true) {
  return new Response(frames.map(f => `data: ${JSON.stringify(f)}\n\n`).join('') + (done ? 'data: [DONE]\n\n' : ''), { headers: { 'content-type': 'text/event-stream' } })
}
function adapterPair(fetcher, extra = {}) {
  const common = { options: () => config, resolveApiKey: async () => 'synthetic-key', resolveUserId: () => 'synthetic-user', ...extra }
  return [new legacy.DeepSeekAdapter(common), new ChatCompletionsCompatAdapter({ ...common, fetch: fetcher, files: extra.files })]
}
async function collect(adapter, request, fetcher) {
  const previous = globalThis.fetch
  globalThis.fetch = fetcher
  try { const chunks = []; for await (const c of adapter.stream(request)) chunks.push(c); return chunks }
  finally { globalThis.fetch = previous }
}
async function wires(oldMessages, newMessages = oldMessages, extra = {}, adapterExtra = {}) {
  const calls = []
  const fetcher = async (url, spec) => { calls.push({ url: String(url), method: spec.method, headers: Object.fromEntries(new Headers(spec.headers)), body: JSON.parse(spec.body) }); return response() }
  const pair = adapterPair(fetcher, adapterExtra)
  for (const [i, a] of pair.entries()) await collect(a, options(i ? newMessages : oldMessages, extra), fetcher)
  assert.equal(calls.length, 2)
  assert.equal(calls[0].url, calls[1].url)
  assert.equal(calls[0].method, calls[1].method)
  assert.equal(calls[0].headers.authorization, calls[1].headers.authorization)
  assert.deepEqual(calls[0].body, calls[1].body)
  return calls
}
test('adapter source resolves exclusively target core', async () => {
  assert.equal(core.version, '0.1.7-rc.2')
  assert.notEqual(await realpath(dirname(corePath)), await realpath(resolve(legacyModules, '@deepseek-ai/dsh-llm')))
  assert.ok(new ChatCompletionsCompatAdapter({ options: () => config, resolveApiKey: async () => 'x', resolveUserId: () => 'u' }) instanceof target.LlmAdapter)
  console.log(JSON.stringify({ sourceRoot: root, targetCoreVersion: core.version, targetCoreRealPath: await realpath(corePath), legacyOracleVersion: JSON.parse(await readFile(resolve(legacyModules, '@deepseek-ai/dsh-llm-deepseek/package.json'), 'utf8')).version }))
})
test('text and native reasoning replay preserve exact legacy request', async () => {
  const assistant = { id: 'a', role: 'assistant', source: modelSource, content: [{ type: 'reasoning', text: 'private synthetic reasoning' }, { type: 'text', text: 'visible answer' }] }
  const calls = await wires([user, assistant, { ...user, id: 'u2' }])
  assert.equal(calls[1].body.messages[2].reasoning_content, 'private synthetic reasoning')
  assert.equal(calls[1].body.messages[2].content, 'visible answer')
})
test('empty assistant/tool call plus native tool result preserve exact legacy wire', async () => {
  const assistant = { id: 'a', role: 'assistant', source: modelSource, content: [{ type: 'tool-call', id: 'call-1', name: 'synthetic_tool', arguments: '{"value":1}' }] }
  const oldResult = { id: 't', role: 'user', source: { kind: 'tool', callId: 'call-1' }, content: [{ type: 'tool-result', toolCallId: 'call-1', content: [{ type: 'text', text: 'synthetic result' }], isError: false }] }
  const newResult = { id: 't', role: 'tool', source: { kind: 'tool', callId: 'call-1' }, toolCallId: 'call-1', content: [{ type: 'text', text: 'synthetic result' }], isError: false }
  const calls = await wires([user, assistant, oldResult], [user, assistant, newResult], { tools })
  assert.equal(calls[1].body.messages[2].content, '')
  assert.equal(Object.hasOwn(calls[1].body.messages[2], 'reasoning_content'), false)
})
test('reasoning plus tool call does not require or fabricate replayState', async () => {
  const assistant = { id: 'a', role: 'assistant', source: modelSource, content: [{ type: 'reasoning', text: 'reason before tool' }, { type: 'tool-call', id: 'call-1', name: 'synthetic_tool', arguments: '{}' }] }
  const calls = await wires([user, assistant], undefined, { tools })
  assert.equal(calls[1].body.messages[2].reasoning_content, 'reason before tool')
  assert.equal(assistant.providerMetadata, undefined)
})
test('SSE reasoning/text/tool fragments, usage and terminal reason equal old parser', async () => {
  const frames = [frame({ reasoning_content: 'think ' }), frame({ reasoning_content: 'more' }), frame({ content: 'answer' }), frame({ tool_calls: [{ index: 0, id: 'call-next', type: 'function', function: { name: 'synthetic_tool', arguments: '{"value":' } }] }), frame({ tool_calls: [{ index: 0, function: { arguments: '7}' } }] }), frame({}, 'tool_calls'), { id: 'response', choices: [], usage: { prompt_tokens: 10, completion_tokens: 8, total_tokens: 18, prompt_cache_hit_tokens: 2, completion_tokens_details: { reasoning_tokens: 3 } } }]
  const fetcher = async () => response(frames)
  const parsed = []
  for (const a of adapterPair(fetcher)) parsed.push(await collect(a, options(), fetcher))
  assert.deepEqual(parsed[1], parsed[0])
  assert.equal(parsed[1].at(-1).reason.kind, 'tool-calls')
  const usage = parsed[1].find(c => c.type === 'usage').usage
  assert.equal(usage.inputTokens, 8)
  assert.equal(usage.cacheReadTokens, 2)
  assert.equal(usage.reasoningTokens, 3)
})
test('HTTP failure is a target LlmError with old routing fields', async () => {
  const fetcher = async () => new Response(JSON.stringify({ error: { message: 'synthetic quota', code: 'insufficient_quota' } }), { status: 429, headers: { 'retry-after': '2', 'x-request-id': 'synthetic-request' } })
  const results = []
  for (const a of adapterPair(fetcher)) { try { await collect(a, options(), fetcher) } catch (e) { results.push(e) } }
  assert.equal(results.length, 2)
  assert.ok(results[1] instanceof target.LlmError)
  for (const k of ['code', 'status', 'providerRetryAfterMs', 'requestId']) assert.equal(results[1][k], results[0][k])
})
test('prepared call retains configuration generation for endpoint, credentials and model', async () => {
  let current = { ...config, apiKeyEnv: 'KEY_OLD' }
  const requests = [], resolved = []
  const adapter = new ChatCompletionsCompatAdapter({ options: () => current, resolveApiKey: async c => { resolved.push(c.apiKeyEnv); return c.apiKeyEnv }, resolveUserId: () => 'u', fetch: async (url, spec) => { requests.push({ url: String(url), auth: new Headers(spec.headers).get('authorization') }); return response() } })
  const prepared = await adapter.prepareCall(provider, model, new AbortController().signal)
  current = { ...config, baseURL: 'https://changed.invalid/v2', apiKeyEnv: 'KEY_NEW', models: [{ ...catalog[0], maxTokens: 42 }] }
  for await (const _ of prepared.stream(options())) {}
  assert.equal(requests[0].url, config.baseURL + '/chat/completions')
  assert.equal(requests[0].auth, 'Bearer KEY_OLD')
  assert.deepEqual(resolved, ['KEY_OLD'])
  assert.equal(prepared.model.defaultMaxTokens, 1024)
})
test('prepared generation is detached from mutable input and later model selection is honored', async () => {
  const current = structuredClone(config)
  const requests = []
  const adapter = new ChatCompletionsCompatAdapter({ options: () => current, resolveApiKey: async c => c.apiKeyEnv, resolveUserId: () => 'u', fetch: async (url, spec) => { requests.push({ url: String(url), body: JSON.parse(spec.body) }); return response() } })
  const prepared = await adapter.prepareCall(provider, model, new AbortController().signal)
  current.baseURL = 'https://later.invalid/v3'
  current.models[0].maxTokens = 17
  current.models.push({ ...catalog[0], id: 'synthetic-later-model' })
  for await (const _ of prepared.stream(options())) {}
  assert.equal(requests[0].url, config.baseURL + '/chat/completions')
  assert.equal(prepared.model.defaultMaxTokens, 1024)
  const next = await adapter.prepareCall(provider, 'synthetic-later-model', new AbortController().signal)
  for await (const _ of next.stream(options([user], { model: 'synthetic-later-model' }))) {}
  assert.equal(requests[1].url, current.baseURL + '/chat/completions')
  assert.equal(requests[1].body.model, 'synthetic-later-model')
})
test('caller abort is propagated and fetch sees the aborted signal', async () => {
  const controller = new AbortController()
  let observed
  const fetcher = async (_url, spec) => { observed = spec.signal; controller.abort('synthetic cancellation'); throw new DOMException('synthetic abort', 'AbortError') }
  const adapter = adapterPair(fetcher)[1]
  await assert.rejects(collect(adapter, options([user], { signal: controller.signal }), fetcher), e => e instanceof target.LlmError && e.code === 'ABORTED')
  assert.equal(observed.aborted, true)
})
test('early consumer return aborts transport and cancels reader', async () => {
  let cancelled = false, fetchSignal
  const fetcher = async (_url, spec) => {
    fetchSignal = spec.signal
    return new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(frame({ content: 'first' }))}\n\n`)) }, cancel() { cancelled = true } }))
  }
  const iterator = adapterPair(fetcher)[1].stream(options())[Symbol.asyncIterator]()
  await iterator.next()
  await iterator.return()
  assert.equal(fetchSignal.aborted, true)
  assert.equal(cancelled, true)
})
test('fragmented SSE bytes preserve text and reasoning UTF-8', async () => {
  const data = new TextEncoder().encode(`data: ${JSON.stringify(frame({ reasoning_content: '思考🙂', content: '回答' }))}\r\n\r\ndata: ${JSON.stringify(frame({}, 'stop'))}\n\ndata: [DONE]\n\n`)
  const fetcher = async () => new Response(new ReadableStream({ start(c) { for (let i = 0; i < data.length; i += 3) c.enqueue(data.slice(i, i + 3)); c.close() } }))
  const chunks = await collect(adapterPair(fetcher)[1], options(), fetcher)
  assert.equal(chunks.filter(c => c.type === 'reasoning-delta').map(c => c.text).join(''), '思考🙂')
  assert.equal(chunks.filter(c => c.type === 'text-delta').map(c => c.text).join(''), '回答')
  assert.equal(chunks.at(-1).reason.kind, 'stop')
})
test('truncated stream without finish is not silently successful', async () => {
  const fetcher = async () => response([frame({ content: 'unfinished' })], false)
  await assert.rejects(collect(adapterPair(fetcher)[1], options(), fetcher), e => e instanceof target.LlmError)
})
test('DONE sentinel without finish_reason preserves the supported legacy stop boundary', async () => {
  const fetcher = async () => response([frame({ content: 'unfinished' })], true)
  const parsed = []
  for (const adapter of adapterPair(fetcher)) parsed.push(await collect(adapter, options(), fetcher))
  assert.deepEqual(parsed[1], parsed[0])
  assert.equal(parsed[1].at(-1).reason.kind, 'stop')
})
test('EOF after declared finish still requires DONE, matching the old parser', async () => {
  const fetcher = async () => response([frame({ content: 'complete' }), frame({}, 'stop')], false)
  const pair = adapterPair(fetcher)
  // A finish_reason is not a substitute for the old adapter's DONE boundary.
  await assert.rejects(collect(pair[0], options(), fetcher), e => e.code === 'STREAM_CLOSED')
  await assert.rejects(collect(pair[1], options(), fetcher), e => e instanceof target.LlmError && e.code === 'STREAM_CLOSED')
})
test('malformed SSE payload is not silently ignored', async () => {
  const fetcher = async () => new Response('data: {broken-json}\n\ndata: [DONE]\n\n')
  await assert.rejects(collect(adapterPair(fetcher)[1], options(), fetcher), e => e instanceof target.LlmError)
})

const imageData = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aP1sAAAAASUVORK5CYII=', 'base64')
const imageRef = { attachmentId: 'sha256:' + '1'.repeat(64), mediaType: 'image/png', bytes: imageData.length, width: 1, height: 1, name: 'synthetic.png' }
const imageVersion = { variantId: 'sha256:' + '2'.repeat(64), attachment: imageRef, data: imageData, mediaType: 'image/png', bytes: imageData.length, width: 1, height: 1, depth: 'uchar', space: 'srgb', hasAlpha: true }
async function imageWires(oldMessages, newMessages = oldMessages, fileUpload = false) {
  const calls = [], policies = [], uploads = []
  const fetcher = async (url, spec) => { calls.push({ url: String(url), body: JSON.parse(spec.body) }); return response() }
  const files = { ensureUploaded: async (...args) => { uploads.push(args); if (!fileUpload) throw new Error('synthetic force-inline'); return { record: { fileId: 'synthetic-file-id' } } }, invalidate: async () => {} }
  const attachments = { readImageRequest: async (_ref, policy) => { policies.push(policy); return imageVersion } }
  const pair = adapterPair(fetcher, { resolveAttachments: () => attachments, resolveFiles: () => files, files })
  for (const [i, a] of pair.entries()) await collect(a, options(i ? newMessages : oldMessages), fetcher)
  assert.equal(calls.length, 2)
  assert.equal(calls[0].url, calls[1].url)
  assert.equal(policies[0].maxPixels, catalog[0].imagePixelBudget)
  assert.equal(policies[0].maxBytes, policies[1].maxBytes)
  assert.equal(policies[1].width, 1)
  assert.equal(policies[1].height, 1)
  return { calls, uploads }
}
test('user image bytes/order/detail and capability limits retain legacy semantics', async () => {
  const message = { ...user, content: [{ type: 'text', text: 'before' }, { type: 'image', attachment: imageRef }, { type: 'text', text: 'after' }] }
  const { calls } = await imageWires([message])
  const content = calls.map(c => c.body.messages.at(-1).content)
  assert.deepEqual(content[0].map(c => c.type), content[1].map(c => c.type))
  assert.deepEqual(content[0].filter(c => c.type === 'image_url'), content[1].filter(c => c.type === 'image_url'))
  assert.equal(content[1][0].text, 'before')
  assert.equal(content[1].at(-1).text, 'after')
  // Handle text is the new public helper's projection, not hidden wire normalization.
  assert.equal(content[1][1].text, '\n' + target.requestImageHandleText(imageRef, imageVersion, undefined))
})
test('tool image maps native tool role to the old separate user-image projection', async () => {
  const content = [{ type: 'text', text: 'tool output' }, { type: 'image', attachment: imageRef }]
  const oldResult = { id: 't', role: 'user', source: { kind: 'tool', callId: 'call-1' }, content: [{ type: 'tool-result', toolCallId: 'call-1', content, isError: false }] }
  const newResult = { id: 't', role: 'tool', source: { kind: 'tool', callId: 'call-1' }, toolCallId: 'call-1', content, isError: false }
  const { calls } = await imageWires([oldResult], [newResult])
  assert.deepEqual(calls[0].body.messages.map(m => m.role), calls[1].body.messages.map(m => m.role))
  assert.equal(calls[1].body.messages[1].tool_call_id, 'call-1')
  assert.equal(calls[1].body.messages.at(-1).content[0].text, 'Attached image(s) from tool result:')
  assert.deepEqual(calls[0].body.messages.at(-1), calls[1].body.messages.at(-1))
  assert.equal(calls[1].body.messages[1].content, 'tool output\n' + target.requestImageHandleText(imageRef, imageVersion, undefined))
})
test('Files representation and one dispatch credential generation match legacy', async () => {
  const { calls, uploads } = await imageWires([{ ...user, content: [{ type: 'image', attachment: imageRef }] }], undefined, true)
  assert.deepEqual(calls[0].body.messages.at(-1).content.filter(c => c.type === 'file'), calls[1].body.messages.at(-1).content.filter(c => c.type === 'file'))
  assert.equal(uploads.length, 2)
  for (const args of uploads) assert.deepEqual(args[1], { baseURL: config.baseURL, apiKey: 'synthetic-key' })
})
test('already offloaded image sends target durable placeholder without attachment IO', async () => {
  let reads = 0, uploads = 0
  const fetcher = async (_url, spec) => { const body = JSON.parse(spec.body); assert.equal(body.messages.at(-1).content, target.offloadedImageText(imageRef, undefined)); return response() }
  const adapter = adapterPair(fetcher, { resolveAttachments: () => ({ readImageRequest: async () => { reads++; return imageVersion } }), files: { ensureUploaded: async () => { uploads++; throw new Error('must not upload') }, invalidate: async () => {} } })[1]
  await collect(adapter, options([{ ...user, content: [{ type: 'image', attachment: imageRef, offloaded: true }] }]), fetcher)
  assert.equal(reads, 0)
  assert.equal(uploads, 0)
})
test('Files quota failure never lists or deletes prefix-matching external uploads', async () => {
  const { DeepSeekFileStore } = await import('../src/files.mjs')
  const calls = []
  const index = { get: async () => undefined, commit: async () => { throw new Error('quota must not commit') }, remove: async () => {} }
  const fetcher = async (url, spec) => {
    calls.push({ url: String(url), method: spec.method })
    if (spec.method === 'GET') return Response.json({ object: 'list', data: [{ id: 'external-file', object: 'file', filename: 'dsh-external-same-prefix.png', bytes: 1, created_at: 1, purpose: 'user_data' }], has_more: false })
    if (spec.method === 'DELETE') return Response.json({ id: 'external-file', deleted: true })
    return Response.json({ error: { message: 'synthetic storage quota', code: 'storage_quota_exceeded' } }, { status: 429 })
  }
  const files = new DeepSeekFileStore({ index, fetch: fetcher, now: () => 1000 })
  await assert.rejects(files.ensureUploaded(imageVersion, { baseURL: config.baseURL, apiKey: 'synthetic-key' }, { expiresAfterSeconds: 3600, refreshMarginSeconds: 1, quotaCleanupBatch: 100 }), e => e instanceof target.LlmError)
  assert.deepEqual(calls.map(c => c.method), ['POST'])
})
test('invalid image roles and late invalid content reject before any reads/uploads/chat', async () => {
  const cases = [
    [{ ...user, role: 'assistant', source: modelSource, content: [{ type: 'image', attachment: imageRef }] }],
    [{ ...user, role: 'system', source: { kind: 'system-prompt' }, content: [{ type: 'image', attachment: imageRef }] }],
    [{ ...user, content: [{ type: 'image', attachment: imageRef }] }, { id: 'd', role: 'developer', source: { kind: 'user' }, content: [{ type: 'text', text: 'unprojected update' }] }],
  ]
  for (const messages of cases) {
    let reads = 0, uploads = 0, chats = 0
    const fetcher = async () => { chats++; return response() }
    const adapter = adapterPair(fetcher, { resolveAttachments: () => ({ readImageRequest: async () => { reads++; return imageVersion } }), files: { ensureUploaded: async () => { uploads++; return { record: { fileId: 'synthetic-file' } } }, invalidate: async () => {} } })[1]
    await assert.rejects(collect(adapter, options(messages), fetcher), e => e instanceof target.LlmError && e.code === 'UNSUPPORTED_CONTENT')
    assert.deepEqual({ reads, uploads, chats }, { reads: 0, uploads: 0, chats: 0 })
  }
})
test('stale file retry preserves one endpoint and credential snapshot', async () => {
  let current = structuredClone(config), resolves = 0, uploads = 0
  const connections = [], requests = [], invalidations = []
  const files = {
    ensureUploaded: async (_version, connection) => { connections.push(connection); return { record: { fileId: `file-${++uploads}` } } },
    invalidate: async (_version, id, connection) => invalidations.push({ id, connection }),
  }
  const adapter = new ChatCompletionsCompatAdapter({ options: () => current, resolveApiKey: async () => { resolves++; return 'dispatch-key' }, resolveUserId: () => 'u', resolveAttachments: () => ({ readImageRequest: async () => imageVersion }), files, fetch: async (url, spec) => {
    requests.push({ url: String(url), auth: new Headers(spec.headers).get('authorization') })
    if (requests.length === 1) { current = { ...config, baseURL: 'https://rotated.invalid/v2', apiKeyEnv: 'ROTATED_KEY' }; return Response.json({ error: { message: 'file not found' } }, { status: 400 }) }
    return response()
  } })
  for await (const _ of adapter.stream(options([{ ...user, content: [{ type: 'image', attachment: imageRef }] }]))) {}
  assert.equal(resolves, 1)
  assert.equal(uploads, 2)
  assert.equal(invalidations.length, 1)
  assert.deepEqual(requests, Array(2).fill({ url: config.baseURL + '/chat/completions', auth: 'Bearer dispatch-key' }))
  assert.ok(connections.every(c => c.baseURL === config.baseURL && c.apiKey === 'dispatch-key'))
})
test('idle timeout aborts a native-fetch-like stream and raises target TIMEOUT', async () => {
  let signal
  const fetcher = async (_url, spec) => {
    signal = spec.signal
    return new Response(new ReadableStream({ start(c) {
      c.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(frame({ content: 'first' }))}\n\n`))
      spec.signal.addEventListener('abort', () => c.error(new DOMException('synthetic body abort', 'AbortError')), { once: true })
    } }))
  }
  const adapter = new ChatCompletionsCompatAdapter({ options: () => ({ ...config, streamIdleTimeoutMs: 10 }), resolveApiKey: async () => 'x', resolveUserId: () => 'u', fetch: fetcher })
  await assert.rejects(collect(adapter, options(), fetcher), e => e instanceof target.LlmError && e.code === 'TIMEOUT')
  assert.equal(signal.aborted, true)
})
