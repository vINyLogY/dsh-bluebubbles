import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import childProcess from 'node:child_process'
import nodeFs from 'node:fs'
import {createRequire,syncBuiltinESMExports}from'node:module'
import {pathToFileURL}from'node:url'
import {assertCohort}from'./cohort-contract.mjs'

// Private fixture inputs must be owned copies. No credentials, real IDs, model
// names, or content belong in this repository or in its output.
const [snapshot,runtime,output,mode='negative',extraPatch]=process.argv.slice(2)
const bridgeLib=process.env.DSH_COMPAT_BRIDGE_LIB
const candidateEngine=process.env.DSH_WORKFLOW_CANDIDATE_SOURCE
const heartbeatMetadata=process.env.DSH_HEARTBEAT_METADATA
assert.ok(snapshot&&runtime&&output)
const canonicalSpelling=p=>path.resolve(p).replace(/^\/tmp(?=\/|$)/,'/private/tmp')
const snapshotPhysical=await fs.realpath(snapshot),outputParent=await fs.realpath(path.dirname(output)),outputPhysical=path.join(outputParent,path.basename(output))
assert.equal(snapshotPhysical,canonicalSpelling(snapshot),'Snapshot symlink ancestor is not allowed')
assert.equal(outputParent,canonicalSpelling(path.dirname(output)),'Output symlink ancestor is not allowed')
assert.ok(snapshotPhysical.startsWith('/private/tmp/'),'Snapshot must be owned temporary storage')
assert.ok(outputPhysical.startsWith('/private/tmp/'),'Output must be owned temporary storage')
assert.ok((await fs.stat(snapshotPhysical)).isDirectory())
assert.equal((await fs.stat(snapshotPhysical)).uid,process.getuid())
assert.equal((await fs.stat(outputParent)).uid,process.getuid())
const disjoint=(a,b)=>a!==b&&!a.startsWith(b+'/')&&!b.startsWith(a+'/')
for(const protectedPath of[snapshotPhysical,await fs.realpath(runtime),...(candidateEngine?[await fs.realpath(candidateEngine)]:[])])assert.ok(disjoint(outputPhysical,protectedPath),'Output must be disjoint from all source/runtime paths')
await assert.rejects(fs.lstat(outputPhysical),{code:'ENOENT'},'Output must be absent')
await fs.mkdir(output,{mode:0o700})
const home=path.join(output,'home');await fs.cp(snapshot,home,{recursive:true,preserveTimestamps:true,verbatimSymlinks:true});await fs.chmod(home,0o700)
try{await fs.rename(home+'/.env',home+'/.env.offline-preserved')}catch(e){if(e.code!=='ENOENT')throw e}
await fs.writeFile(home+'/heartbeat-targets.json','{}',{mode:0o600});await fs.writeFile(home+'/cron-jobs.json','{"jobs":{}}',{mode:0o600})
const bindings=Object.values(JSON.parse(await fs.readFile(snapshot+'/bluebubbles-bindings.json'))),heartbeat=Object.values(JSON.parse(await fs.readFile(snapshot+'/heartbeat-targets.json')))[0],workspaces=JSON.parse(await fs.readFile(snapshot+'/storages/workspace.json')).tables.workspaces
const heartbeatId=heartbeat.sessionId??Object.values(workspaces).find(x=>x.path===heartbeat.workspacePath)?.sessionIds[0]
assert.equal(bindings.length,2);assert.ok(heartbeatId)
for(const key of Object.keys(process.env))if(key!=='PATH')delete process.env[key]
Object.assign(process.env,{HOME:home,DSH_HOME:home,DEEPSEEK_BASE_URL:'https://offline.invalid/v1',BLUEBUBBLES_BASE_URL:'https://offline.invalid',BLUEBUBBLES_PASSWORD:'synthetic'})
await fs.mkdir(home+'/tmp',{mode:0o700});process.env.TMPDIR=home+'/tmp'
const require=createRequire(runtime+'/package.json'),modules=path.dirname(path.dirname(path.dirname(require.resolve('@deepseek-ai/dsh-llm/package.json'))))
assert.equal(JSON.parse(await fs.readFile(require.resolve('@deepseek-ai/dsh-llm/package.json'))).version,'0.1.7-rc.2')
let deniedSubprocesses=0,networkAttempts=0,agentInputs=0,nativeWorkflowPhase=false,nativeWorkflowProcesses=0
const nativeStderr=[],originalSpawn=(...args)=>{const child=childProcessSpawn(...args);if(nativeWorkflowPhase)child.stderr?.on('data',chunk=>nativeStderr.push(String(chunk)));return child},childProcessSpawn=childProcess.spawn
const originalSpawnSync=childProcess.spawnSync,ptcBootstrap=path.join(path.dirname(require.resolve('@deepseek-ai/dsh-ptc-runtime-node')),'process.js')
for(const name of ['spawn','spawnSync','exec','execSync','execFile','execFileSync','fork'])childProcess[name]=(...args)=>{if(name==='spawn'&&args[0]==='/usr/bin/xcode-select'&&args[1]?.length===1&&args[1][0]==='-p')return originalSpawn(...args);if(name==='spawn'&&String(args[0]).endsWith('/git')&&args[1]?.[0]==='rev-parse'&&String(args[2]?.cwd??'').startsWith(home+'/'))return originalSpawn(...args);if(nativeWorkflowPhase&&path.basename(String(args[0]))==='sandbox-exec'){const a=args[1];assert.equal(a[0],'-p');assert.ok(a[1].includes('(deny file-write*)'));assert.equal(a[2],'--');if(name==='spawnSync'&&a.length===4&&a[3]==='true')return originalSpawnSync(...args);if(name==='spawn'){assert.equal(a.length,7);assert.equal(a[3],process.execPath);assert.match(a[4],/^--max-old-space-size=\d+$/);assert.equal(a[5],ptcBootstrap);assert.match(a[6],/^\d+$/);nativeWorkflowProcesses++;return originalSpawn(...args)}}deniedSubprocesses++;throw Error('OFFLINE_SUBPROCESS_DENIED')}
syncBuiltinESMExports()
globalThis.fetch=async()=>{networkAttempts++;throw Error('OFFLINE_NETWORK_DENIED')}
await fs.writeFile(home+'/offline-shell-fence.mjs',`export const inject=['shell'];export function apply(ctx){ctx.shell.execute=async spec=>{if(!spec.command.startsWith('curl '))throw new Error('OFFLINE_SHELL_DENIED');return{result:async()=>({exitCode:0,stdout:{text:JSON.stringify({status:200,data:spec.command.includes('/api/v1/webhook?')?[{id:1,url:'http://127.0.0.1:3080/bluebubbles/webhook'}]:{}})},stderr:{text:''},timedOut:false})}}}`,{mode:0o600})
const originalProfile=await fs.readFile(home+'/profiles/web/cordis.patch.yml','utf8')
let candidatePrefix='',compositionProof,cohortProof
if(candidateEngine){
 assert.ok(heartbeatMetadata);const hbMetadata=JSON.parse(await fs.readFile(heartbeatMetadata,'utf8')),hbHandleMetadata=hbMetadata.headers?.[0]??hbMetadata.header??hbMetadata;assert.equal(hbHandleMetadata.id,heartbeatId);const preset=hbHandleMetadata.agentPreset,presetDir=path.join(home,'.agent-presets',preset),originalFile=path.join(presetDir,'agent.cordis.yml'),sourceBytes=await fs.readFile(originalFile)
 await fs.cp(candidateEngine,path.join(presetDir,'compat-engine'),{recursive:true,verbatimSymlinks:true,preserveTimestamps:true})
 const engineEntry=path.join(presetDir,'compat-engine/index.mjs');cohortProof=[await assertCohort(engineEntry,runtime+'/package.json')]
 for(const file of await fs.readdir(path.join(presetDir,'compat-engine')))if(file.endsWith('.cjs'))cohortProof.push(await assertCohort(path.join(presetDir,'compat-engine',file),runtime+'/package.json'))
 const {parse}=await import(pathToFileURL(path.join(runtime,'node_modules/yaml/dist/index.js'))),tags=[{tag:'tag:yaml.org,2002:js',resolve:value=>({__jsExpr:value})}],rows=parse(sourceBytes.toString(),{customTags:tags}),changed=structuredClone(rows);let replacementCount=0,totalDeclarations=0,personaTransforms=0
 function replace(v){if(!v||typeof v!=='object')return;if(typeof v.name==='string')totalDeclarations++;if(v.name==='@deepseek-ai/dsh-workflow-worker-thread'){v.name=pathToFileURL(engineEntry).href;replacementCount++}if(v.name==='@deepseek-ai/dsh-persona'){assert.equal(typeof v.config?.text,'string');assert.equal(Object.hasOwn(v.config,'prefix'),false);assert.equal(Object.hasOwn(v.config,'suffix'),false);v.config.prefix=v.config.text;delete v.config.text;v.config.suffix='';personaTransforms++}for(const child of Object.values(v))replace(child)}replace(changed);assert.equal(replacementCount,1);assert.equal(personaTransforms,1)
 const restored=structuredClone(changed);function undo(v){if(!v||typeof v!=='object')return;if(v.name===pathToFileURL(engineEntry).href)v.name='@deepseek-ai/dsh-workflow-worker-thread';if(v.name==='@deepseek-ai/dsh-persona'){v.config.text=v.config.prefix;delete v.config.prefix;delete v.config.suffix}for(const child of Object.values(v))undo(child)}undo(restored);assert.deepEqual(restored,rows,'Unreviewed composition transformation')
 const metadata=parse(await fs.readFile(path.join(presetDir,'preset.yml'),'utf8'));await fs.writeFile(path.join(presetDir,'candidate-definition-private.json'),JSON.stringify({id:preset,...metadata,plugins:changed}),{mode:0o600})
 const wrapper=path.join(presetDir,'target-preset-definition.mjs')
 await fs.writeFile(wrapper,`import{readFile}from'node:fs/promises';export const inject=['agentPresets'];export async function apply(ctx){const config=JSON.parse(await readFile(new URL('./candidate-definition-private.json',import.meta.url)));const caller=ctx.extend({baseUrl:new URL('./agent.cordis.yml',import.meta.url).href});const dispose=await caller.agentPresets.register(config);ctx.effect(()=>dispose)}`,{mode:0o600})
 candidatePrefix='- insert:\n    - id: offline-qualified-private-preset\n      name: '+wrapper+'\n'
 const findPersona=v=>{if(!v||typeof v!=='object')return;if(v.name==='@deepseek-ai/dsh-persona')return v.config;for(const child of Object.values(v)){const result=findPersona(child);if(result)return result}}
 const oldPersona=findPersona(rows),newPersona=findPersona(changed);assert.equal(oldPersona.text,newPersona.prefix);assert.equal(newPersona.suffix,'');assert.equal(oldPersona.complete,newPersona.complete);assert.equal(oldPersona.includeRuntimeContext,newPersona.includeRuntimeContext)
 compositionProof={originalRawSha256:crypto.createHash('sha256').update(sourceBytes).digest('hex'),originalPresetFileUnchanged:true,totalDeclarations,replacementCount,personaTransforms,personaTextSha256:crypto.createHash('sha256').update(oldPersona.text).digest('hex'),personaPrefixSha256:crypto.createHash('sha256').update(newPersona.prefix).digest('hex'),personaFlagsUnchanged:true,personaSuffixEmpty:true,approvedPersonaTransformation:'exact legacy text -> prefix; suffix empty; complete/includeRuntimeContext unchanged',allOtherConfigAndOrderUnchanged:true,relativeBasePreservedBySamePresetDirectoryAndOriginalFilename:true,fixtureBaseUrlIsCopiedOriginalComposition:true}
 await fs.writeFile(output+'/composition-plan-private.json',JSON.stringify({original:rows,candidate:changed,originalBaseUrl:pathToFileURL(originalFile).href}),{mode:0o600})
}
await fs.writeFile(home+'/profiles/web/cordis.patch.yml','- insert:\n    - id: offline-shell-fence\n      name: '+home+'/offline-shell-fence.mjs\n'+candidatePrefix+originalProfile+'\n- id: hmr\n  disabled: true\n',{mode:0o600})
// Restored Session.cwd remains authentic. A preset must not be able to write
// that production workspace or a host-runtime directory during cold setup.
const originalRealpathSync=nodeFs.realpathSync,writeRoot=originalRealpathSync(output)
let deniedExternalWrites=0;const privateDeniedWrites=[]
function confined(value){if(typeof value==='number')throw Error('UNOWNED_FILE_DESCRIPTOR_WRITE');const p=path.resolve(value instanceof URL?new URL(value).pathname:String(value));let ancestor=p;while(!nodeFs.existsSync(ancestor)){const parent=path.dirname(ancestor);if(parent===ancestor)break;ancestor=parent}const physical=path.resolve(originalRealpathSync(ancestor),path.relative(ancestor,p));if(physical!==writeRoot&&!physical.startsWith(writeRoot+'/')){deniedExternalWrites++;privateDeniedWrites.push({path:physical,stack:new Error().stack});throw Error('OFFLINE_EXTERNAL_WRITE_DENIED')}}
const indices={writeFile:[0],appendFile:[0],mkdir:[0],rm:[0],rmdir:[0],unlink:[0],chmod:[0],chown:[0],truncate:[0],utimes:[0],rename:[0,1],copyFile:[1],cp:[1],symlink:[1],link:[1]}
for(const[name,args]of Object.entries(indices)){if(typeof fs[name]==='function'){const original=fs[name].bind(fs);fs[name]=(...values)=>{for(const index of args)confined(values[index]);return original(...values)}}for(const method of[name,name+'Sync'])if(typeof nodeFs[method]==='function'){const original=nodeFs[method].bind(nodeFs);nodeFs[method]=(...values)=>{for(const index of args)confined(values[index]);return original(...values)}}}
const writeFlags=nodeFs.constants.O_WRONLY|nodeFs.constants.O_RDWR|nodeFs.constants.O_CREAT|nodeFs.constants.O_TRUNC|nodeFs.constants.O_APPEND
for(const target of[fs,nodeFs]){const original=target.open.bind(target);target.open=(...values)=>{const flags=values[1]??'r';if(typeof flags==='number'?(flags&writeFlags)!==0:/[wa+]/.test(flags))confined(values[0]);return original(...values)}}
const originalOpenSync=nodeFs.openSync.bind(nodeFs);nodeFs.openSync=(...values)=>{const flags=values[1]??'r';if(typeof flags==='number'?(flags&writeFlags)!==0:/[wa+]/.test(flags))confined(values[0]);return originalOpenSync(...values)}
syncBuiltinESMExports()
const {runProfile}=await import(pathToFileURL(require.resolve('@deepseek-ai/dsh/lib/profile-boot.js'))),{createLaunchEnvironmentSnapshot}=await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-launch-environment'))),{Session}=await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-session')))
const digest=x=>crypto.createHash('sha256').update(JSON.stringify(x)).digest('hex'),logs=[],normal=Object.fromEntries(['log','warn','error','info','debug'].map(k=>[k,console[k]]));for(const k of Object.keys(normal))console[k]=(...args)=>logs.push(args.map(String).join(' '))
let boot,failed=false;const handles=[],ptcOutcomes=[]
try{
 boot=await runProfile({environment:createLaunchEnvironmentSnapshot([{source:'process',values:{...process.env}}]),profile:'web',patchFiles:extraPatch?[extraPatch]:[],args:['--no-open','--port','0']})
 const actualPtc=boot.ctx.get('ptcRuntime'),originalPtcRun=actualPtc.run.bind(actualPtc);actualPtc.run=async(...args)=>{const result=await originalPtcRun(...args);ptcOutcomes.push(result);return result}
 const rows=[],states=[]
 for(const [index,id]of [...bindings.map(x=>x.sessionId),heartbeatId].entries()){
  const handle=await boot.ctx.sessionPersistence.open(id,'read');try{const data=await handle.read(),session=Session.fromRestore(id,data.events,handle.header,handle.inheritedEventCount,data.eventState),selectionEvents=data.events.filter(e=>e.type==='agent-preset/selected'),effective=selectionEvents.at(-1)?.data.agentPreset??handle.header.agentPreset
   states.push({id,effective,session,events:data.events,header:handle.header,request:session.requestHeader()?.config,permissionDigest:digest(data.events.filter(e=>e.type.startsWith('permission/')||e.type==='approval/request'))})
   rows.push({label:index===2?'heartbeat':index===0?'binding-A':'binding-B',lastSelectionPresent:selectionEvents.length>0,effectiveDiffersHeader:effective!==handle.header.agentPreset,nativeFormat:handle.header.version,events:data.events.length})
  }finally{await handle.close()}
 }
 const targets=[{label:'registry-default',id:boot.ctx.agentPresets.defaultId},...states.map((s,i)=>({label:rows[i].label,id:s.effective}))],catalog=[],catalogById=new Map()
 for(const target of targets){if(!catalogById.has(target.id)){try{const preset=await boot.ctx.agentPresets.resolve(target.id);assert.equal(preset.id,target.id);if(preset.broken){await fs.writeFile(output+'/private-broken-preset.txt',preset.broken,{mode:0o600});throw Object.assign(Error('PRESET_BROKEN'),{code:'PRESET_BROKEN'})}catalogById.set(target.id,{resolved:true,broken:false})}catch(e){catalogById.set(target.id,{resolved:false,errorCode:e.code??e.name})}}catalog.push({label:target.label,...catalogById.get(target.id)})}
 const coldResume=[],pureWorkflows=[]
 await fs.writeFile(output+'/partial-catalog.json',JSON.stringify({mode,rows,catalog,networkAttempts,agentInputs,deniedSubprocesses,deniedExternalWrites,compositionProof,cohortProof},null,2),{mode:0o600})
 if(mode==='negative'){assert.equal(catalog.find(x=>x.label==='binding-B').resolved,false);assert.equal(catalog.find(x=>x.label==='heartbeat').resolved,false)}else{
  if(mode==='a-control'){assert.ok(catalog.find(x=>x.label==='binding-A').resolved);assert.equal(catalog.find(x=>x.label==='binding-B').resolved,false);assert.equal(catalog.find(x=>x.label==='heartbeat').resolved,false)}else assert.ok(catalog.every(x=>x.resolved&&!x.broken))
  assert.ok(bridgeLib,'Candidate requires explicit reviewed bridge lib with same physical host SDK')
  const bridgeRequire=createRequire(bridgeLib);assert.equal(await fs.realpath(bridgeRequire.resolve('@deepseek-ai/dsh-session')),await fs.realpath(require.resolve('@deepseek-ai/dsh-session')))
  const {ensureLiveAgent}=await import(pathToFileURL(bridgeLib)),resume=boot.ctx.agents.resume.bind(boot.ctx.agents),mount=boot.ctx.agentPresets.mount.bind(boot.ctx.agentPresets),calls=new Map(),mounts=[]
  boot.ctx.agentPresets.mount=async(ctx,id)=>{const result=await mount(ctx,id);assert.equal(result.id,id);mounts.push(id);return result}
  boot.ctx.agents.resume=async options=>{calls.set(options.resumeSessionId,options.agentOptions);const handle=await resume(options);handles.push(handle);return handle}
  boot.ctx.on('agent/request',()=>{agentInputs++;throw Error('COLD_RESUME_MUST_NOT_DISPATCH_MODEL')})
  for(const [index,state]of (mode==='a-control'?states.slice(0,1):states).entries()){
   assert.equal(boot.ctx.agents.get(state.id),undefined)
   const agent=await ensureLiveAgent(boot.ctx,boot.ctx.agents,state.id);assert.ok(agent);assert.equal(agent.id,state.id);assert.equal(agent.session.id,state.id);assert.ok(mounts.includes(state.effective));assert.equal(agent.status,'idle');assert.equal(agent.inbox.nextTurn.length+agent.inbox.nextStep.length,0)
   assert.equal(digest(agent.session.snapshotEvents(0,state.events.length)),digest(state.events),'Cold resume changed original history prefix')
   assert.deepEqual(agent.session.requestHeader()?.config,state.request,'Cold resume changed stored model config')
   assert.equal(digest(agent.session.snapshotEvents().filter(e=>e.type.startsWith('permission/')||e.type==='approval/request')),state.permissionDigest,'Cold resume changed permission history')
   const wanted=state.request??boot.ctx.agentDefaultModel.currentSelection(),selected=calls.get(state.id);assert.equal(selected.provider,wanted.provider);assert.equal(selected.model,wanted.model)
   assert.equal(selected.reasoningEffort,wanted.reasoningEffort);assert.equal(selected.maxTokens,wanted.maxTokens)
   coldResume.push({label:rows[index].label,actualOriginalIdResumed:true,effectivePresetPubliclyMounted:true,historyPrefixUnchanged:true,storedModelConfigUnchanged:true,permissionEventsUnchanged:true,idleWithEmptyInbox:true})
   if(mode==='candidate-workflow'&&index>0){nativeWorkflowPhase=true;let run;try{const engine=boot.ctx.agentPresets.serviceFor(agent,'workflowEngine');assert.ok(engine);run=engine.start({script:'return {synthetic:true}',meta:{name:'synthetic-profile-control',description:'synthetic'},parent:agent});const result=await run.result;await fs.writeFile(output+'/private-workflow-result-'+index+'.json',JSON.stringify(result),{mode:0o600});assert.deepEqual(result,{value:{synthetic:true},stopReason:'completed',agentsStarted:0});pureWorkflows.push({label:rows[index].label,actualMountedEngine:true,publicServiceApi:'agentPresets.serviceFor',actualSessionPolicyNoOverride:true,productionRuntimeConfigNoOverride:true,pureLiteralCompleted:true})}finally{if(run)await run.dispose();nativeWorkflowPhase=false}}
  }
  if(mode!=='a-control')assert.ok(mounts.includes(boot.ctx.agentPresets.defaultId),'Default must be same publicly mounted revision or receive its own real scoped mount gate')
  const inventory=await boot.ctx.agentPresets.compositionInventory();for(const target of(mode==='a-control'?targets.filter(x=>x.label==='binding-A'):targets)){const item=inventory.find(x=>x.id===target.id);assert.ok(item&&!item.broken)}
 }
 const receipt={pass:true,mode,expectedNegative:mode==='negative',stockNextVersion:'0.1.7-rc.2',snapshotQualification:'COMPLETE_RUNNING_COPY_NOT_COHERENT',testOnlyNotPromotable:true,testSessionEventsMustNeverReplaceLiveHistory:true,futureLiveChangeWouldBeReviewedCodeAndMinimalConfigOnly:true,effectiveLastPresetFolded:true,rows,catalog,coldResume,pureWorkflows,nativeWorkflowProcesses,compositionProof,cohortProof,privateRegistryRetainUsed:false,publicBindingApi:'agents.resume + agentPresets.mount(actual scoped Agent context)',networkAttempts,agentInputs,deniedSubprocesses,deniedExternalWrites,productionWorkspaceWritesFenced:true,realProviderCalls:0,realMessages:0,coldResumeNotYetExecuted:mode==='negative',officialProviders:{sandboxPolicy:!!boot.ctx.get('sandboxPolicy'),sandbox:!!boot.ctx.get('sandbox'),ptcRuntime:!!boot.ctx.get('ptcRuntime'),sandboxedNodePtcRuntime:!!boot.ctx.get('sandboxedNodePtcRuntime')},limitation:mode==='negative'?'Catalog negative only; historical earlier private-retain receipt is not a public mount qualification. Candidate must pass actual cold resume. Live state untouched.':'No tool/model/send execution. Pure workflow script has no tools or child agents; not a complete workflow algorithm qualification.'}
 assert.equal(networkAttempts,0);await fs.writeFile(output+'/receipt.json',JSON.stringify(receipt,null,2),{mode:0o600});normal.log(JSON.stringify(receipt))
}catch(e){failed=true;await fs.writeFile(output+'/private-error.txt',e.stack??String(e),{mode:0o600});normal.log(JSON.stringify({pass:false,errorType:e.name,output}));process.exitCode=1}finally{for(const h of handles.reverse())await h.dispose();if(boot)await boot.shutdown.shutdown(0);await fs.writeFile(output+'/private-native-stderr.txt',nativeStderr.join(''),{mode:0o600});await fs.writeFile(output+'/private-ptc-outcomes.json',JSON.stringify(ptcOutcomes),{mode:0o600});await fs.writeFile(output+'/private-logs.txt',logs.join('\n'),{mode:0o600});await fs.writeFile(output+'/private-write-denials.json',JSON.stringify(privateDeniedWrites),{mode:0o600});for(const[k,v]of Object.entries(normal))console[k]=v;if(failed)process.exitCode=1}
