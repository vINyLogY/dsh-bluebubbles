import test from 'node:test'
import assert from 'node:assert/strict'
import { sendUserMessage } from '../src/lib.ts'
// Root unit tests use the public header shape only: importing the concrete
// Session also loads host peers deliberately installed only by runtime jobs.
// Those jobs assert real headers, checkpoint admission, dispatch and relay.
test('inbound producer spelling follows both supported public header formats', () => {
  for (const version of [0,4]) for (const plugin of ['dsh-bluebubbles','dsh-heartbeat','dsh-cron']) {
    const session={header:{version}}
    const sent=[]
    const agent={session,send:(message,target,wake)=>sent.push({message,target,wake})}
    assert.equal(sendUserMessage({get:()=>agent},'synthetic','synthetic input',plugin,'next-step'),true)
    assert.deepEqual(sent[0].message.source,session.header.version===4?{kind:'plugin:'+plugin}:{kind:'plugin',plugin})
    assert.equal(sent[0].target,'next-step');assert.equal(sent[0].wake,true)
  }
})
test('unknown or missing format refuses delivery instead of guessing legacy/future syntax', () => {
  for (const session of [undefined,{header:undefined},{header:{version:3}},{header:{version:5}},{header:{version:'4'}}]) {
    let sent=false
    assert.equal(sendUserMessage({get:()=>({session,send:()=>{sent=true}})},'synthetic','synthetic input','dsh-bluebubbles'),false)
    assert.equal(sent,false)
  }
})
