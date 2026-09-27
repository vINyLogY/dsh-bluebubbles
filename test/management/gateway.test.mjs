import assert from 'node:assert/strict'
import test from 'node:test'
import {createServer,request as httpRequest} from 'node:http'
import {readFile} from 'node:fs/promises'
import {runInNewContext} from 'node:vm'
import * as cordis from '@deepseek-ai/cordis'
import {Context} from '@deepseek-ai/cordis'
import registry from '@deepseek-ai/dsh-typert-registry'
import * as connection from '@deepseek-ai/dsh-client-connection'
import {TypertGatewayService} from '@deepseek-ai/dsh-api-gateway'
import * as management from '../../management/index.mjs'
import {contribution} from '../../client/bindings-ui/src/contribution.mjs'

test('optional management routes inherit actual Connection cookie and Origin fences', async t => {
  const ctx = new Context(), fibers = [], routes = []
  let secret, mutations = 0
  // Official BrowserAuth creates/signs its own synthetic record in memory.
  ctx.provide('credentials', {async modifyRecord(_key, change) {const update = await change(secret); if (update) secret = update; return secret}})
  ctx.provide('webServer', {register(route) {routes.push(route); return () => routes.splice(routes.indexOf(route), 1)}, registerUpgrade() {return () => {}}})
  ctx.provide('bluebubbles', {bindingManagement: {
    list: () => ({revision: 'a'.repeat(64), bindings: []}),
    sessions: () => ({sessions: [{id: 'synthetic-session', status: 'cold'}]}),
    chats: () => ({chats: [], hasMore: false, nextOffset: 0}),
    bind: () => {mutations++; return {revision: 'b'.repeat(64), bindings: []}},
    unbind: () => {mutations++; return {revision: 'b'.repeat(64), bindings: []}},
    updateRelay: () => {mutations++; return {revision: 'b'.repeat(64), bindings: []}},
  }})
  for (const [plugin, config] of [[registry], [connection, {}], [TypertGatewayService, {}], [management]]) {const f=ctx.plugin(plugin, config); fibers.push(f); await f}
  const server=createServer(async(req,res)=>{
    if (req.url.startsWith('/?')) {ctx.connection.authorizeIndex(req,res); return}
    const route=routes.find(r=>r.kind==='prefix'&&req.url.startsWith(r.path))
    if (!route) {res.writeHead(404);res.end();return}
    try {await route.handler(req,res)} catch {res.writeHead(500);res.end('test-handler-error')}
  })
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
  t.after(async()=>{await new Promise(resolve=>server.close(resolve));for(const f of fibers.reverse())await f.dispose()})
  const base='http://127.0.0.1:'+server.address().port
  const args={chatGuid:'synthetic-chat',sessionId:'synthetic-session',relay:true,expectedRevision:'a'.repeat(64)}
  const call=(method,cookie,extra={},body={args:{args}})=>fetch(base+'/api/bluebubblesBindings/'+method,{method:'POST',headers:{'content-type':'application/json',...(cookie?{cookie}:{}),...extra},body:JSON.stringify({type:'client-request',rpcId:'synthetic-'+method,method:'bluebubblesBindings/'+method,payload:body})})
  assert.equal((await call('bind')).status,401)
  const exchange=await fetch(ctx.connection.authenticatedUrl(base+'/'),{redirect:'manual'})
  assert.equal(exchange.status,303)
  const cookie=exchange.headers.get('set-cookie').split(';')[0]
  assert.equal((await call('bind',cookie,{origin:'https://foreign.invalid'})).status,403)
  assert.equal((await call('bind',cookie,{'sec-fetch-site':'cross-site'})).status,403)
  const badHostStatus=await new Promise((resolve,reject)=>{
    const req=httpRequest(base+'/api/bluebubblesBindings/bind',{method:'POST',headers:{host:'foreign.invalid',cookie,'content-type':'application/json'}},res=>{res.resume();res.on('end',()=>resolve(res.statusCode))})
    req.on('error',reject);req.end(JSON.stringify({type:'client-request',rpcId:'synthetic-bad-host',method:'bluebubblesBindings/bind',payload:{args:{args}}}))
  })
  assert.equal(badHostStatus,403)
  assert.equal(mutations,0)
  const listed=await call('list',cookie,{}, {args:{}})
  assert.equal(listed.status,200); const listedBody=(await listed.json()).result;assert.ok(listedBody.value,JSON.stringify(listedBody)); assert.deepEqual(listedBody.value.bindings,[])
  const bound=await call('bind',cookie)
  assert.equal(bound.status,200); assert.equal((await bound.json()).result.ok,true);assert.equal(mutations,1)
  const invalid=await call('bind',cookie,{}, {args:{args:{...args,password:'must-not-be-accepted'}}})
  assert.equal((await invalid.json()).result.ok,false);assert.equal(mutations,1)
  assert.equal((await fetch(base+'/bluebubbles/bind',{method:'POST',body:JSON.stringify(args)})).status,404)
  // Actual official browser Remote face mounts the real client contribution,
  // then speaks through the authenticated HTTP carrier above (no fake $mount).
  let bundle
  runInNewContext(await readFile(new URL(import.meta.resolve('@deepseek-ai/dsh-api-gateway/client')), 'utf8'), {window:{__ModuleLoader__:{load(value){bundle=value}}},crypto:globalThis.crypto,AbortController,AbortSignal,URL,setTimeout,clearTimeout,queueMicrotask,TextEncoder,TextDecoder,console})
  const clientGateway=bundle.factory(name=>{assert.equal(name,'@deepseek-ai/cordis');return cordis})
  const client=new Context(), clientFibers=[]
  client.provide('connection',{registerGenerationSource(){return ()=>{}},start(){return {stop(){}}},generation:{getSnapshot(){}},isLoopback:true,rpc:{open(){throw new Error('No streams expected in binding management')},async call(_channel,endpoint,payload){
    const response=await fetch(base+'/api/'+endpoint,{method:'POST',headers:{'content-type':'application/json',cookie},body:JSON.stringify({type:'client-request',rpcId:'synthetic-browser',method:endpoint,payload})})
    assert.equal(response.status,200);return (await response.json()).result
  }}})
  for (const plugin of [registry,clientGateway]) {const f=client.plugin(plugin);clientFibers.push(f);await f}
  t.after(async()=>{for(const f of clientFibers.reverse())await f.dispose()})
  const unmount=await client.remote.$mount(contribution);t.after(unmount)
  assert.equal((await client.get('remote.bluebubblesBindings').list()).ok,true)
  assert.equal((await client.get('remote.bluebubblesBindings').bind(args)).ok,true)
  assert.equal(mutations,2)
  assert.equal((await client.get('remote.bluebubblesBindings').bind({...args,password:'synthetic-forbidden'})).ok,false)
  assert.equal(mutations,2)
})
