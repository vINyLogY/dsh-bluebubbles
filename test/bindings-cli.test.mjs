import assert from 'node:assert/strict'
import test from 'node:test'
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {spawnSync} from 'node:child_process'
import {readBindings,updateBindings} from '../src/bindings-store.ts'
test('the shipped CLI cooperates with host locks, preserves legacy fields, and invalidates old revisions', async t=>{
 const home=await mkdtemp(join(tmpdir(),'dsh-cli-bindings-'));t.after(()=>rm(home,{recursive:true,force:true}))
 const path=join(home,'bluebubbles-bindings.json')
 await writeFile(path,JSON.stringify({'chat:synthetic-A':{workspacePath:'/synthetic/workspace',extension:{retained:true}}}))
 const initial=await readBindings(path)
 const cli=(...args)=>spawnSync(process.execPath,['bin/bb-channel.mjs',...args],{cwd:new URL('../',import.meta.url),env:{PATH:process.env.PATH,HOME:home,DSH_HOME:home},encoding:'utf8'})
 let entered,release
 const ready=new Promise(r=>entered=r),gate=new Promise(r=>release=r)
 const host=updateBindings(path,initial.revision,async table=>{entered();await gate;table['chat:synthetic-B']={sessionId:'synthetic-B'}})
 await ready
 assert.equal(cli('bind','synthetic-A','--session','synthetic-A','--relay').status,1)
 release();await host
 const beforeCli=await readBindings(path)
 assert.equal(cli('bind','synthetic-A','--session','synthetic-A','--relay').status,0)
 const final=await readBindings(path)
 assert.notEqual(final.revision,beforeCli.revision)
 assert.equal(final.bindings['chat:synthetic-A'].workspacePath,undefined)
 assert.equal(final.bindings['chat:synthetic-A'].extension.retained,true)
 assert.equal(final.bindings['chat:synthetic-B'].sessionId,'synthetic-B')
 await assert.rejects(updateBindings(path,beforeCli.revision,()=>{}),e=>e.code==='conflict')
 assert.equal(cli('unbind','synthetic-A').status,0)
 assert.equal((await readBindings(path)).bindings['chat:synthetic-A'],undefined)
 assert.ok((await readFile(path,'utf8')).includes('synthetic-B'))
})
