import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {createRequire} from 'node:module'
import {Context,Service} from '@deepseek-ai/cordis'
import {Session} from '@deepseek-ai/dsh-session'
import Engine from '../src/index.mjs'
const require=createRequire(import.meta.url)
const canaryParent=process.env.DSH_WORKFLOW_CANARY_PARENT
assert.ok(canaryParent,'DSH_WORKFLOW_CANARY_PARENT must identify an authorized owned non-temp fixture parent')
assert.ok(!canaryParent.startsWith('/tmp/')&&!canaryParent.startsWith('/private/tmp/'),'write-denial controls must not use the globally writable temp roots')
const importSdk=name=>import(require.resolve('@deepseek-ai/'+name))
class NoChildProvider extends Service {
 constructor(ctx){super(ctx,'subagents')}
 getProvider(){return{}}
 start(...args){if(this.handler)return this.handler(...args);throw new Error('child dispatch forbidden in childless control')}
}
test('real public Node PTC sandbox runner executes unchanged legacy guest and disposes',{timeout:20000},async()=>{
 const root=await mkdtemp(join(tmpdir(),'dsh-legacy-workflow-control-'))
 for(const key of Object.keys(process.env))if(key!=='PATH')delete process.env[key]
 Object.assign(process.env,{HOME:root,DSH_HOME:root})
 const ctx=new Context(),fibers=[],events=[]
 try{
  for(const name of ['dsh-session','dsh-session-projection','dsh-fs-local','dsh-subprocess-local','dsh-sandbox-local','dsh-sandbox-policy','dsh-ptc-runtime-node']){const m=await importSdk(name),config=name==='dsh-sandbox-policy'?{mode:'read-only',workspaceRoot:root}:name==='dsh-ptc-runtime-node'?{timeoutMs:5000,maxTimeoutMs:10000,graceMs:500}:undefined;const f=ctx.plugin(m.default,config);fibers.push(f);await f}
  const f=ctx.plugin(NoChildProvider);fibers.push(f);await f
  const e=ctx.plugin(Engine,{provider:'synthetic',maxConcurrentAgents:1,maxTotalAgents:10,maxItemsPerCall:16,syncTimeoutMs:500,disposeGraceMs:200});fibers.push(e);await e
  assert.equal(ctx.ptcRuntime.language,'typescript');assert.equal(ctx.ptcRuntime.isolation,'process')
  assert.equal(JSON.parse(await readFile(require.resolve('@deepseek-ai/dsh-workflow/package.json'))).version,'0.1.7-rc.2')
  const id='synthetic-parent',session=Session.fromRestore(id,[{seq:0,time:0,type:'sandbox/mode',data:{mode:'read-only'}}],{type:'session',version:4,id,createdAt:0,cwd:root,delegationDepth:0,isSeeded:false,agentPreset:'standard'})
  ctx.on('workflow/start',()=>events.push('start'));ctx.on('workflow/end',()=>events.push('end'))
  const run=ctx.workflowEngine.start({script:'return {answer: args.value + 1}',meta:{name:'synthetic-control',description:'synthetic'},args:{value:41},parent:{id,session}})
  try{const result=await run.result;assert.deepEqual(result,{value:{answer:42},stopReason:'completed',agentsStarted:0});assert.deepEqual(events,['start','end'])}finally{await run.dispose()}
  const start=script=>ctx.workflowEngine.start({script,meta:{name:'synthetic-control',description:'synthetic'},parent:{id,session}})
  const surface=start('return [typeof agent,typeof parallel,typeof pipeline,typeof phase,typeof log,typeof args,typeof require,typeof process,typeof module,typeof Buffer,typeof fetch,typeof setTimeout]')
  try{assert.deepEqual((await surface.result).value,['function','function','function','function','function','undefined','undefined','undefined','undefined','undefined','undefined','undefined'])}finally{await surface.dispose()}
  const dynamic=start('return await import("node:fs")')
  try{assert.equal((await dynamic.result).stopReason,'error')}finally{await dynamic.dispose()}
  const failure=start('throw new Error("synthetic failure")')
  try{assert.equal((await failure.result).stopReason,'error')}finally{await failure.dispose()}
  assert.throws(()=>start('export const meta = {}'),error=>error.code==='SCRIPT_PARSE')
  // A provider which publishes AFTER cancellation must not leak a child or result rejection.
  const started=Promise.withResolvers(),late=Promise.withResolvers();let disposed=0
  ctx.subagents.handler=async()=>{started.resolve();return late.promise}
  const child=start('return await agent("synthetic prompt")')
  await started.promise
  child.cancel('synthetic cancellation')
  // Force the bounded holder teardown to finish before provider publication.
  await child.dispose()
  late.resolve({id:'synthetic-child',result:Promise.reject(new Error('synthetic late result')),dispose:async()=>{disposed++}})
  try{assert.equal((await child.result).stopReason,'cancelled')}finally{await child.dispose()}
  await new Promise(resolve=>setImmediate(resolve))
  assert.equal(disposed,1)
  // Host admission is authoritative even if a sandboxed guest spoofs a protocol frame.
  const admitted=Promise.withResolvers(),publish=Promise.withResolvers();disposed=0
  ctx.subagents.handler=async()=>{admitted.resolve();return publish.promise}
  const duplicate=start('return await agent("synthetic prompt")')
  await admitted.promise
  duplicate.onChildStart(1,{prompt:'duplicate'})
  publish.resolve({id:'synthetic-child',result:Promise.resolve({output:[],stopReason:'completed'}),dispose:async()=>{disposed++}})
  try{assert.equal((await duplicate.result).stopReason,'error')}finally{await duplicate.dispose()}
  assert.equal(disposed,1)
 }finally{for(const f of fibers.reverse())await f.dispose()}
})
test('actual legacy guest is confined, scrubbed and subject to finite runtime/output budgets',{timeout:20000},async()=>{
 const root=await mkdtemp(join(canaryParent,'.workflow-owned-')),outside=await mkdtemp(join(canaryParent,'.workflow-denied-')),ctx=new Context(),fibers=[]
 const target=join(outside,'synthetic.txt'),inside=join(root,'synthetic.txt')
 await writeFile(target,'unchanged');await writeFile(inside,'unchanged')
 const keys=['DEEPSEEK_API_KEY','BLUEBUBBLES_PASSWORD','BROWSER_TOKEN','SYNTHETIC_NON_CREDENTIAL'];for(const key of keys)process.env[key]='synthetic-not-secret'
 try{
  for(const name of ['dsh-session','dsh-session-projection','dsh-fs-local','dsh-subprocess-local','dsh-sandbox-local','dsh-sandbox-policy','dsh-ptc-runtime-node']){const m=await importSdk(name),config=name==='dsh-sandbox-policy'?{mode:'read-only',workspaceRoot:root}:name==='dsh-ptc-runtime-node'?{timeoutMs:500,maxTimeoutMs:1000,graceMs:100}:undefined;const f=ctx.plugin(m.default,config);fibers.push(f);await f}
  const provider=ctx.plugin(NoChildProvider);fibers.push(provider);await provider
  const engine=ctx.plugin(Engine,{provider:'synthetic',maxConcurrentAgents:1,maxTotalAgents:10,maxItemsPerCall:16,syncTimeoutMs:200,disposeGraceMs:100,maxProtocolBytes:2048,maxProtocolEvents:20});fibers.push(engine);await engine
  const start=(mode,script,args)=>{const id='synthetic-parent',session=Session.fromRestore(id,[{seq:0,time:0,type:'sandbox/mode',data:{mode}}],{type:'session',version:4,id,createdAt:0,cwd:root,delegationDepth:0,isSeeded:false,agentPreset:'standard'});return ctx.workflowEngine.start({script,args,meta:{name:'synthetic',description:'synthetic'},parent:{id,session}})}
  const runResult=async(mode,script,args)=>{const run=start(mode,script,args);try{return await run.result}finally{await run.dispose();assert.equal(run.worker.waiter,undefined);assert.equal(run.worker.closed,true)}}
  const escapedWrite='const p=log.constructor("return process")(); p.getBuiltinModule("node:fs").writeFileSync(args.path,"changed");return true'
  for(const mode of ['read-only','workspace-write']){const result=await runResult(mode,escapedWrite,{path:target});assert.equal(result.stopReason,'error');assert.match(result.error,/EPERM|operation not permitted/i);assert.equal(await readFile(target,'utf8'),'unchanged')}
  assert.equal((await runResult('read-only',escapedWrite,{path:inside})).stopReason,'error');assert.equal(await readFile(inside,'utf8'),'unchanged')
  assert.equal((await runResult('workspace-write',escapedWrite,{path:inside})).stopReason,'completed');assert.equal(await readFile(inside,'utf8'),'changed')
  const env=await runResult('read-only','const p=log.constructor("return process")();return args.keys.map(key=>Object.hasOwn(p.env,key))',{keys});assert.deepEqual(env.value,[false,false,false,false])
  const flooded=await runResult('read-only','for(let i=0;i<100;i++) log("synthetic".repeat(20));return null');assert.equal(flooded.stopReason,'error');assert.match(flooded.error,/protocol budget/)
  const timed=await runResult('read-only','await Promise.resolve();while(true) {}');assert.equal(timed.stopReason,'error');assert.match(timed.error,/timeout/)
 }finally{for(const f of fibers.reverse())await f.dispose();for(const key of keys)delete process.env[key];await rm(root,{recursive:true});await rm(outside,{recursive:true})}
})
test('actual public SubagentRuntime honors override capabilities and legacy progress order',{timeout:20000},async()=>{
 const root=await mkdtemp(join(tmpdir(),'dsh-legacy-workflow-sdk-')),ctx=new Context(),fibers=[]
 try{
  for(const name of ['dsh-session','dsh-session-projection','dsh-fs-local','dsh-subprocess-local','dsh-sandbox-local','dsh-sandbox-policy','dsh-ptc-runtime-node','dsh-subagent']){const m=await importSdk(name),config=name==='dsh-sandbox-policy'?{mode:'read-only',workspaceRoot:root}:name==='dsh-ptc-runtime-node'?{timeoutMs:5000,maxTimeoutMs:10000,graceMs:500}:undefined;const f=ctx.plugin(m.default,config);fibers.push(f);await f}
  let calls=0,disposed=0,request
  const capabilities={agentOptions:true,outputSchema:true,depthLimit:false,toolFilter:false,persona:false}
  const provider={name:'synthetic',capabilities,start:async value=>{calls++;request=value;return{id:'synthetic-child',result:Promise.resolve({output:[{type:'text',text:'synthetic answer'}],stopReason:'completed'}),dispose:async()=>{disposed++}}}}
  ctx.subagents.registerProvider(provider)
  ctx.subagents.registerProvider({...provider,name:'unsupported',capabilities:{...capabilities,agentOptions:false}})
  const e=ctx.plugin(Engine,{provider:'synthetic',maxConcurrentAgents:1,maxTotalAgents:10,maxItemsPerCall:16,syncTimeoutMs:500,disposeGraceMs:200});fibers.push(e);await e
  const id='synthetic-parent',session=Session.fromRestore(id,[{seq:0,time:0,type:'sandbox/mode',data:{mode:'read-only'}}],{type:'session',version:4,id,createdAt:0,cwd:root,delegationDepth:0,isSeeded:false,agentPreset:'standard'})
  const order=[];for(const name of ['workflow/start','workflow/agent-start','workflow/agent-end','workflow/end'])ctx.on(name,()=>order.push(name))
  const run=ctx.workflowEngine.start({script:'return await agent("synthetic prompt", {provider:"synthetic-model-provider",model:"synthetic-model"})',meta:{name:'synthetic',description:'synthetic'},parent:{id,session}})
  try{const result=await run.result;assert.equal(result.stopReason,'completed');assert.equal(result.value,'synthetic answer');assert.deepEqual(request.agentOptions,{provider:'synthetic-model-provider',model:'synthetic-model'});assert.deepEqual(order,['workflow/start','workflow/agent-start','workflow/agent-end','workflow/end'])}finally{await run.dispose()}
  assert.equal(calls,1);assert.equal(disposed,1)
  const denied=ctx.workflowEngine.start({script:'return await agent("synthetic prompt", {model:"synthetic-model"})',subagentProvider:'unsupported',meta:{name:'synthetic',description:'synthetic'},parent:{id,session}})
  try{const result=await denied.result;assert.equal(result.stopReason,'error');assert.match(result.error,/does not support.*agentOptions/)}finally{await denied.dispose()}
  assert.equal(calls,1)
  // Tombstone correlation permits the old legal late-end race, without double end.
  const settled=Promise.withResolvers(),observed=Promise.withResolvers();let cleanup=0
  ctx.subagents.registerProvider({name:'pending',capabilities,start:async()=>({id:'synthetic-pending',result:settled.promise,dispose:async()=>{cleanup++;settled.resolve({output:[],stopReason:'cancelled'})}})})
  let info,endCount=0,endResultCount=0
  const offStart=ctx.on('workflow/agent-start',(_run,value)=>{info=value;observed.resolve()})
  const offEnd=ctx.on('workflow/agent-end',()=>{endCount++})
  const offResult=ctx.on('workflow/end',()=>{endResultCount++})
  const racing=ctx.workflowEngine.start({script:'return await agent("synthetic prompt")',subagentProvider:'pending',meta:{name:'synthetic',description:'synthetic'},parent:{id,session}})
  await observed.promise
  racing.endStrandedAgents()
  racing.onMessage({type:'agent-end',info:{...info,outcome:'cancelled'}})
  assert.equal(racing.workerDeathObserved,false)
  racing.onMessage({type:'agent-end',info:{...info,childId:'foreign-child',outcome:'cancelled'}})
  assert.equal((await racing.result).stopReason,'error')
  await racing.dispose()
  assert.equal(cleanup,1);assert.equal(endCount,1);assert.equal(endResultCount,1)
  offStart();offEnd();offResult()
 }finally{for(const f of fibers.reverse())await f.dispose()}
})
