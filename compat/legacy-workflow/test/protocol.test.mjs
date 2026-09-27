import test from 'node:test'
import assert from 'node:assert/strict'
import {validateWorkerMessage,validateTransportFrame} from '../src/protocol.mjs'
test('closed worker protocol accepts legacy shapes and refuses capability/extra/malformed frames',()=>{
 const valid=[{type:'ready'},{type:'phase',title:'synthetic'},{type:'log',message:'synthetic'},{type:'child-start',callId:1,request:{prompt:'synthetic',provider:'synthetic',model:'synthetic',schema:{type:'string'}}},{type:'child-dispose',callId:1},{type:'agent-start',info:{seq:1,label:'synthetic',childId:'synthetic'}},{type:'agent-end',info:{seq:1,label:'synthetic',childId:'synthetic',outcome:'completed'}},{type:'result',result:{value:null,agentsStarted:1,stopReason:'completed'}}]
 for(const value of valid)assert.equal(validateTransportFrame({type:'message',value}).value,value)
 const invalid=[{type:'ready',capability:{}},{type:'child-start',callId:1,request:{prompt:'synthetic',parent:{}}},{type:'child-start',callId:NaN,request:{prompt:'synthetic'}},{type:'child-start',callId:1,request:{prompt:'synthetic',provider:42}},{type:'child-start',callId:1,request:{prompt:'synthetic',schema:[]}},{type:'agent-start',info:{seq:0,label:'synthetic',childId:'synthetic'}},{type:'result',result:{value:null,agentsStarted:-1,stopReason:'completed'}},{type:'unknown'}]
 for(const value of invalid)assert.throws(()=>validateWorkerMessage(value),TypeError)
 assert.throws(()=>validateTransportFrame({type:'exit',code:0,capability:{}}),TypeError)
})
