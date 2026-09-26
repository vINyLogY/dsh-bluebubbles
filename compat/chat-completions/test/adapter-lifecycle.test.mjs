import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { LlmError } from '@deepseek-ai/dsh-llm'
import { ChatCompletionsCompatAdapter, resolveOptions } from '../src/adapter.ts'
import * as entry from '../src/index.ts'
import { DeepSeekFileStore } from '../src/files.mjs'
const config = {provider:'synthetic-compat',baseURL:'https://offline.invalid/v1',apiKeyEnv:'SYNTHETIC_KEY',models:[{id:'synthetic-model',inputModalities:['text','image'],imageMaxBytes:1024}]}
const user = {id:'u',role:'user',source:{kind:'user'},content:[{type:'text',text:'synthetic input'}]}
const ref = {attachmentId:'sha256:'+'1'.repeat(64),name:'synthetic.png',mediaType:'image/png',bytes:4,width:1,height:1}
const image = {type:'image',attachment:ref}
const version = {variantId:'sha256:'+'2'.repeat(64),attachment:ref,data:new Uint8Array([1,2,3,4]),mediaType:'image/png',bytes:4,width:1,height:1,depth:'uchar',space:'srgb',hasAlpha:false}
const request = messages => ({provider:config.provider,model:'synthetic-model',messages})
const response = () => new Response('data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n')
async function collect(stream) { const rows=[]; for await (const row of stream) rows.push(row); return rows }
test('request snapshot is captured before lazy dispatch and survives mutation during attachment reads', async () => {
  const input=request([{...structuredClone(user),content:[structuredClone(image)]}])
  let body,uploaded
  const adapter=new ChatCompletionsCompatAdapter({options:()=>config,resolveApiKey:async()=> 'synthetic',resolveUserId:()=> 'u',resolveAttachments:()=>({readImageRequest:async attachment=>{
    assert.equal(attachment.attachmentId,ref.attachmentId)
    input.messages[0].role='system';input.messages[0].content[0].attachment.attachmentId='changed-during-read'
    return version
  }}),files:{ensureUploaded:async value=>{uploaded=value;return{record:{fileId:'synthetic-file'}}},invalidate:async()=>{}},fetch:async(_url,init)=>{body=JSON.parse(init.body);return response()}})
  const stream=adapter.stream(input)
  input.provider='changed-before-next';input.model='changed-before-next';input.messages[0].role='assistant';input.messages[0].content[0].attachment.attachmentId='changed-before-next'
  await collect(stream)
  assert.equal(uploaded.variantId,version.variantId)
  assert.equal(body.model,'synthetic-model');assert.equal(body.messages[0].role,'user')
  assert.ok(JSON.stringify(body.messages).includes('synthetic-file'))
})
test('whole-request preflight rejects late unsupported roles with zero IO', async () => {
  for (const role of ['assistant','system','developer']) {
    const counters={reads:0,uploads:0,credentials:0,fetches:0}
    const adapter=new ChatCompletionsCompatAdapter({options:()=>config,resolveApiKey:async()=>{counters.credentials++;return 'synthetic'},resolveUserId:()=> 'u',resolveAttachments:()=>({readImageRequest:async()=>{counters.reads++;return version}}),files:{ensureUploaded:async()=>{counters.uploads++;return{record:{fileId:'synthetic-file'}}},invalidate:async()=>{}},fetch:async()=>{counters.fetches++;return response()}})
    const invalid={id:'invalid',role,source:{kind:role==='assistant'?'model':'system-prompt',provider:config.provider,model:'synthetic-model'},content:[image]}
    await assert.rejects(collect(adapter.stream(request([{...user,content:[image]},invalid]))),error=>error instanceof LlmError && error.code==='UNSUPPORTED_CONTENT')
    assert.deepEqual(counters,{reads:0,uploads:0,credentials:0,fetches:0})
  }
})
test('durable offload request leaves input unchanged and makes no upload/chat request', async () => {
  const input=request([{...user,content:[image]}]),before=structuredClone(input)
  let calls=0
  const adapter=new ChatCompletionsCompatAdapter({options:()=>({...config,maxRequestFilesBytes:1}),resolveApiKey:async()=>{calls++;return 'synthetic'},resolveUserId:()=> 'u',resolveAttachments:()=>({readImageRequest:async()=>version}),files:{ensureUploaded:async()=>{calls++;return{record:{fileId:'synthetic-file'}}},invalidate:async()=>{}},fetch:async()=>{calls++;return response()}})
  await assert.rejects(collect(adapter.stream(input)),error=>error instanceof LlmError && error.code==='IMAGE_OFFLOAD_REQUIRED' && error.failure.offloadImages===1)
  assert.equal(calls,0);assert.deepEqual(input,before)
})
test('stale file retry resolves credentials once and preserves endpoint/key through second POST', async () => {
  let resolutions=0,uploads=0,invalidations=0;const calls=[]
  const adapter=new ChatCompletionsCompatAdapter({options:()=>config,resolveApiKey:async()=>{resolutions++;return 'synthetic'},resolveUserId:()=> 'u',resolveAttachments:()=>({readImageRequest:async()=>version}),files:{ensureUploaded:async(_version,connection)=>{uploads++;assert.equal(connection.apiKey,'synthetic');return{record:{fileId:'synthetic-'+uploads}}},invalidate:async(_version,id,connection)=>{invalidations++;assert.equal(id,'synthetic-1');assert.equal(connection.apiKey,'synthetic')}},fetch:async(url,init)=>{calls.push({url,auth:new Headers(init.headers).get('authorization')});return calls.length===1?new Response('{"error":{"message":"file expired"}}',{status:400}):response()}})
  const rows=await collect(adapter.stream(request([{...user,content:[image]}])))
  assert.equal(rows.at(-1).reason.kind,'stop');assert.equal(resolutions,1);assert.equal(uploads,2);assert.equal(invalidations,1);assert.equal(calls.length,2);assert.deepEqual(calls[1],calls[0])
})
test('idle timeout is target LlmError TIMEOUT and aborts the transport', async () => {
  let signal
  const adapter=new ChatCompletionsCompatAdapter({options:()=>({...config,streamIdleTimeoutMs:5}),resolveApiKey:async()=> 'synthetic',resolveUserId:()=> 'u',fetch:async(_url,init)=>{signal=init.signal;return await new Promise((_resolve,reject)=>{init.signal.addEventListener('abort',()=>reject(init.signal.reason),{once:true})})}})
  await assert.rejects(collect(adapter.stream(request([user]))),error=>error instanceof LlmError && error.code==='TIMEOUT');assert.equal(signal.aborted,true)
})
test('actual SDK prepared calls enforce mismatch/reuse and project unsupported developer updates', async () => {
  const ctx=new Context(),fiber=ctx.plugin(LlmRuntime);await fiber
  const calls=[]
  try {
    const adapter=new ChatCompletionsCompatAdapter({options:()=>config,resolveApiKey:async()=> 'synthetic',resolveUserId:()=> 'u',fetch:async(_url,init)=>{calls.push(JSON.parse(init.body));return response()}})
    ctx.llm.registerAdapter([config.provider],adapter)
    const call=await ctx.llm.prepareCall({provider:config.provider,model:'synthetic-model'})
    const input={...call.config,messages:[{id:'d',role:'developer',source:{kind:'synthetic-extension'},content:[{type:'tool-removal',toolName:'old'}]},user],tools:[]}
    const rows=await collect(call.stream(input));assert.equal(rows.at(-1).reason.kind,'stop');assert.deepEqual(calls[0].messages,[{role:'user',content:'synthetic input'}])
    assert.throws(()=>call.stream(input),error=>error.code==='INVALID_PREPARED_CALL')
    const other=await ctx.llm.prepareCall({provider:config.provider,model:'synthetic-model'})
    assert.throws(()=>other.stream({...other.config,model:'different',messages:[user]}),error=>error.code==='INVALID_PREPARED_CALL')
    assert.equal(calls.length,1)
  } finally {await fiber.dispose()}
})
test('entry is opt-in, duplicate route refuses atomically, plugin disposal releases only own route', async () => {
  const ctx=new Context(),core=ctx.plugin(LlmRuntime);await core
  try {
    assert.deepEqual(ctx.llm.listProviders(),[])
    const unrelated={...config,provider:'unrelated'}
    const release=ctx.llm.registerAdapter([unrelated.provider],new ChatCompletionsCompatAdapter({options:()=>unrelated,resolveApiKey:async()=> 'x',resolveUserId:()=> 'u'}))
    const registered=ctx.plugin(entry,config);await registered
    assert.equal(ctx.llm.listProviders().length,2)
    assert.throws(()=>ctx.llm.registerAdapter([config.provider],new ChatCompletionsCompatAdapter({options:()=>config,resolveApiKey:async()=> 'x',resolveUserId:()=> 'u'})),error=>error.code==='DUPLICATE_ADAPTER')
    assert.equal(ctx.llm.listProviders().length,2)
    await registered.dispose();assert.deepEqual(ctx.llm.listProviders().map(row=>row.id),['unrelated'])
    release()
  } finally {await core.dispose()}
})
test('resolved retry/config/catalog typos are rejected rather than silently ignored', () => {
  assert.throws(()=>resolveOptions({...config,models:[{id:123}]}))
  assert.throws(()=>resolveOptions({...config,defaults:{thinking:'enabled',unknown:true}}))
  assert.throws(()=>resolveOptions({...config,retryPolicy:{mode:'normal',initialDelayMs:1,maxDelayMs:10,jitterRatio:0,maxRetries:1,retryableCodes:['TIMEOUT'],unknown:true}}))
  assert.throws(()=>resolveOptions({...config,fileQuotaCleanupBatch:100}))
})
test('shared upload keeps the remaining waiter alive when another waiter cancels', async () => {
  let started,finish,transportSignal,posts=0
  const ready=new Promise(resolve=>{started=resolve})
  const files=new DeepSeekFileStore({now:()=>1000,index:{get:async()=>undefined,commit:async candidate=>({accepted:true,record:candidate})},fetch:async(_url,init)=>{
    posts++;transportSignal=init.signal;started()
    return await new Promise(resolve=>{finish=()=>resolve(Response.json({id:'synthetic-file',object:'file',filename:'synthetic.png',purpose:'user_data',bytes:4,created_at:1,expires_at:3601}))})
  }})
  const abort=new AbortController(),connection={baseURL:config.baseURL,apiKey:'synthetic'},policy={expiresAfterSeconds:3600,refreshMarginSeconds:1,quotaCleanupBatch:0}
  const first=files.ensureUploaded(version,connection,policy,abort.signal)
  const rejected=assert.rejects(first)
  const second=files.ensureUploaded(version,connection,policy)
  await ready;abort.abort();await rejected
  assert.equal(transportSignal.aborted,false);finish()
  assert.equal((await second).record.fileId,'synthetic-file');assert.equal(posts,1)
})
