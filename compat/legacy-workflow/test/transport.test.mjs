import test from 'node:test'
import assert from 'node:assert/strict'
import {PtcWorker} from '../src/transport.mjs'

// Controlled public-runtime seam test, NOT native sandbox proof.
for (const mode of ['abort','exit','error','throw']) test('pending host receive settles on '+mode, async()=>{
 const entered=Promise.withResolvers(),finish=Promise.withResolvers()
 let pending=0,received,exits=0
 const runtime={language:'typescript',isolation:'process',resolve:spec=>({...spec,timeoutMs:1000}),run:async spec=>{
   const host=spec.bindings[0].functions
   const receive=host.receive({});pending++;receive.then(value=>{pending--;received=value})
   entered.resolve()
   if(mode==='abort') await new Promise(resolve=>spec.signal.addEventListener('abort',resolve,{once:true}))
   else await finish.promise
   if(mode==='exit') await host.publish({type:'exit',code:0})
   if(mode==='throw') throw new Error('synthetic runtime failure')
   return mode==='error'?{error:{kind:'synthetic'}}:{}
 }}
 const worker=new PtcWorker('/synthetic',{workerData:{limits:{maxProtocolBytes:10000,maxProtocolEvents:100}},env:{}},runtime,{mode:'read-only',workspaceRoot:'/synthetic'})
 worker.on('error',()=>{});worker.on('exit',()=>exits++)
 await entered.promise
 assert.equal(pending,1)
 if(mode==='abort') await worker.terminate();else{finish.resolve();await worker.done}
 await Promise.resolve()
 assert.equal(pending,0);assert.deepEqual(received,{type:'closed'});assert.equal(worker.waiter,undefined);assert.equal(worker.queue.length,0);assert.equal(exits,1)
 await worker.terminate();assert.equal(exits,1)
})

for (const direction of ['guest','host']) test('cumulative protocol events are bounded for '+direction,async()=>{
 let host,errors=0,exits=0
 const ready=Promise.withResolvers()
 const runtime={language:'typescript',isolation:'process',resolve:spec=>({...spec,timeoutMs:1000}),run:async spec=>{
   host=spec.bindings[0].functions;ready.resolve()
   await new Promise(resolve=>spec.signal.addEventListener('abort',resolve,{once:true}))
   return {error:{kind:'abort'}}
 }}
 const worker=new PtcWorker('/synthetic',{workerData:{limits:{maxProtocolBytes:10000,maxProtocolEvents:1}},env:{}},runtime,{mode:'read-only',workspaceRoot:'/synthetic'})
 worker.on('error',()=>errors++);worker.on('exit',()=>exits++)
 await ready.promise
 const message={type:'log',message:'synthetic'}
 if(direction==='guest'){
   assert.equal(await host.publish({type:'message',value:message}),null)
   await assert.rejects(host.publish({type:'message',value:message}),/budget/)
 }else{
   worker.postMessage(message)
   assert.throws(()=>worker.postMessage(message),/budget/)
 }
 await worker.done
 assert.equal(worker.controller.signal.aborted,true);assert.equal(worker.closed,true);assert.equal(worker.queue.length,0);assert.equal(errors,1);assert.equal(exits,1)
})

