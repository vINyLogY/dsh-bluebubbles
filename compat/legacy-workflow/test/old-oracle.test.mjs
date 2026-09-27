import test from 'node:test'
import assert from 'node:assert/strict'
import {Worker} from 'node:worker_threads'
import {createRequire} from 'node:module'
import {mkdtemp,readFile} from 'node:fs/promises'
import {join,dirname} from 'node:path'
import {tmpdir} from 'node:os'
import {Context,Service} from '@deepseek-ai/cordis'
import {Session} from '@deepseek-ai/dsh-session'
import Engine from '../src/index.mjs'
const require=createRequire(import.meta.url)
const legacy=process.env.DSH_LEGACY_NODE_MODULES
assert.ok(legacy,'DSH_LEGACY_NODE_MODULES must identify the verified old oracle cohort')
const oldRequire=createRequire(join(legacy,'oracle.cjs'))
const oldEntry=join(dirname(oldRequire.resolve('@deepseek-ai/dsh-workflow-worker-thread')),'worker.cjs')
assert.equal(JSON.parse(await readFile(join(legacy,'@deepseek-ai/dsh-workflow-worker-thread/package.json'))).version,'0.1.1-rc.2')
class NoChildren extends Service{constructor(ctx){super(ctx,'subagents')}getProvider(){return{}}start(){throw new Error('oracle child dispatch forbidden')}}
async function oldScenario(body,childMode=false){
 const worker=new Worker(oldEntry,{env:{},execArgv:[],workerData:{meta:{name:'synthetic',description:'synthetic'},body,args:{value:2},limits:{maxConcurrentAgents:1,maxTotalAgents:10,maxItemsPerCall:16,syncTimeoutMs:200}}})
 const requests=[],events=[]
 try{return await new Promise((resolve,reject)=>{worker.on('error',reject);worker.on('message',message=>{
  if(message.type==='ready')worker.postMessage({type:'go'})
  if(message.type==='child-start'){
   if(!childMode){reject(new Error('unexpected oracle child request'));return}
   requests.push(message.request)
   worker.postMessage({type:'child-started',callId:message.callId,childId:'synthetic-child'})
   if(childMode==='cancel')worker.postMessage({type:'cancel',reason:'synthetic cancellation'})
   worker.postMessage({type:'child-settled',callId:message.callId,result:{output:[{type:'text',text:'synthetic answer'}],stopReason:childMode==='cancel'?'cancelled':'completed'}})
  }
  if(message.type==='child-dispose')worker.postMessage({type:'child-disposed',callId:message.callId})
  if(message.type==='agent-start'||message.type==='agent-end')events.push({type:message.type,info:message.info})
  if(message.type==='result')resolve({result:message.result,requests,events})
 })})}finally{await worker.terminate()}
}
async function oldResult(body){return(await oldScenario(body)).result}
test('old published guest and new confined guest retain DSL/combinator/result semantics',{timeout:20000},async()=>{
 const root=await mkdtemp(join(tmpdir(),'dsh-workflow-oracle-')),ctx=new Context(),fibers=[]
 for(const key of Object.keys(process.env))if(key!=='PATH')delete process.env[key]
 Object.assign(process.env,{HOME:root,DSH_HOME:root})
 try{
  for(const name of ['dsh-session','dsh-session-projection','dsh-fs-local','dsh-subprocess-local','dsh-sandbox-local','dsh-sandbox-policy','dsh-ptc-runtime-node']){const m=await import(require.resolve('@deepseek-ai/'+name));const f=ctx.plugin(m.default,name==='dsh-sandbox-policy'?{mode:'read-only',workspaceRoot:root}:name==='dsh-ptc-runtime-node'?{timeoutMs:2000,maxTimeoutMs:5000,graceMs:100}:undefined);fibers.push(f);await f}
  for(const plugin of [NoChildren,Engine]){const f=ctx.plugin(plugin,plugin===Engine?{provider:'synthetic',maxConcurrentAgents:1,maxTotalAgents:10,maxItemsPerCall:16,syncTimeoutMs:200,disposeGraceMs:100}:undefined);fibers.push(f);await f}
  const id='synthetic',session=Session.fromRestore(id,[{seq:0,time:0,type:'sandbox/mode',data:{mode:'read-only'}}],{type:'session',version:4,id,createdAt:0,cwd:root,delegationDepth:0,isSeeded:false,agentPreset:'standard'})
  const scripts=['return [typeof agent,typeof parallel,typeof pipeline,typeof phase,typeof log,typeof args,typeof require,typeof process,typeof module,typeof Buffer,typeof fetch,typeof setTimeout]','return await parallel([async()=>1,async()=>{throw new Error("synthetic")},async()=>3])','return await pipeline([1,2,3],async x=>x+args.value,async x=>x*2)','return {value:args.value,nested:[null,true,"synthetic"]}','return undefined','return await import("node:fs")']
  for(const script of scripts){const old=await oldResult(script),run=ctx.workflowEngine.start({script,args:{value:2},meta:{name:'synthetic',description:'synthetic'},parent:{id,session}});try{const next=await run.result;assert.equal(next.stopReason,old.stopReason);assert.equal(next.agentsStarted,old.agentsStarted);assert.deepEqual(next.value,old.value);assert.equal(typeof next.error,typeof old.error)}finally{await run.dispose()}}
  // A literal synthetic child host supplies only the public legacy protocol.
  // It never instantiates an Agent or contacts any provider.
  const childScript='return await agent("synthetic prompt",{label:"synthetic label",provider:"synthetic-provider",model:"synthetic-model"})'
  const old=await oldScenario(childScript,true),events=[],requests=[];let disposed=0
  ctx.subagents.start=async(_provider,request)=>{requests.push({prompt:request.prompt[0].text,provider:request.agentOptions.provider,model:request.agentOptions.model});return{id:'synthetic-child',result:Promise.resolve({output:[{type:'text',text:'synthetic answer'}],stopReason:'completed'}),dispose:async()=>{disposed++}}}
  ctx.on('workflow/agent-start',(_info,info)=>events.push({type:'agent-start',info}));ctx.on('workflow/agent-end',(_info,info)=>events.push({type:'agent-end',info}))
  const child=ctx.workflowEngine.start({script:childScript,args:{value:2},meta:{name:'synthetic',description:'synthetic'},parent:{id,session}})
  try{assert.deepEqual(await child.result,old.result);assert.deepEqual(requests,old.requests);assert.deepEqual(events,old.events)}finally{await child.dispose()}
  assert.equal(disposed,1)
  const oldCancelled=await oldScenario(childScript,'cancel'),pending=Promise.withResolvers()
  ctx.subagents.start=async()=>({id:'synthetic-child',result:pending.promise,dispose:async()=>{disposed++}})
  let cancelled
  const off=ctx.on('workflow/agent-start',()=>{cancelled.cancel('synthetic cancellation');pending.resolve({output:[],stopReason:'cancelled'})})
  cancelled=ctx.workflowEngine.start({script:childScript,args:{value:2},meta:{name:'synthetic',description:'synthetic'},parent:{id,session}})
  try{const result=await cancelled.result;assert.equal(result.stopReason,oldCancelled.result.stopReason);assert.equal(result.agentsStarted,oldCancelled.result.agentsStarted);assert.deepEqual(result.value,oldCancelled.result.value)}finally{await cancelled.dispose();off()}
  assert.equal(disposed,2)
 }finally{for(const f of fibers.reverse())await f.dispose()}
})
