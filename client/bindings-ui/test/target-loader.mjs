// Actual shipped 0.1.7 browser module table + slot registry. Remote transport
// alone is synthetic here; the host/gateway integration test qualifies RPC.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import vm from 'node:vm';
import React from 'react';
import * as ReactDom from 'react-dom';
import * as ReactDomClient from 'react-dom/client';
import * as jsx from 'react/jsx-runtime';
import {JSDOM} from 'jsdom';
const modules=resolve(process.argv[2]||'missing-target-node-modules');
const requireTarget=createRequire(join(modules,'__synthetic_client__.cjs'));
const actual=async name=>import(pathToFileURL(requireTarget.resolve(name)).href);
const cordis=await actual('@deepseek-ai/cordis');
const slots=await actual('@deepseek-ai/dsh-client-ui-slots');
const version=JSON.parse(await readFile(join(modules,'@deepseek-ai/dsh-client-modules/package.json'),'utf8')).version;
assert.equal(version,'0.1.7-rc.2');
const dom=new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>',{url:'http://synthetic.invalid/'});
globalThis.window=dom.window;globalThis.document=dom.window.document;
let bootstrap;
const target={mode:'queue',pendingQueue:[],load(value){this.pendingQueue.push(value);}};
const context=vm.createContext({window:{__ModuleLoader__:{load:value=>bootstrap=value}},document:dom.window.document,console,setTimeout,clearTimeout,queueMicrotask,URL,AbortController,TextEncoder,TextDecoder});
const official=async name=>readFile(requireTarget.resolve(name+'/client'),'utf8');
vm.runInContext(await official('@deepseek-ai/dsh-client-modules'),context);
const moduleExports=bootstrap.factory(()=>{throw Error('Unexpected bootstrap dependency');});
const loader=new moduleExports.ClientModuleSystem({manifest:{rev:'synthetic',modules:[],plugins:[]},staticModules:{react:React,'react-dom':ReactDom,'react-dom/client':ReactDomClient,'react/jsx-runtime':jsx,'@deepseek-ai/cordis':cordis,'@deepseek-ai/dsh-client-ui-slots':slots},bootstrapModule:{id:'@deepseek-ai/dsh-client-modules',exports:moduleExports},registrationTarget:target,loadBundle:()=>{throw Error('Unexpected external script transport');}});
context.window.__ModuleLoader__=target;
vm.runInContext(await official('@deepseek-ai/dsh-client-ui-renderer'),context);
vm.runInContext(await readFile(new URL('../lib/client.js',import.meta.url),'utf8'),context);
const renderer=await loader.import('@deepseek-ai/dsh-client-ui-renderer');
const entry=await loader.import('@vinylogy/dsh-client-imessage-bindings');
assert.equal(await loader.import('@vinylogy/dsh-client-imessage-bindings'),entry);
const ctx=new cordis.Context();
let mounts=0,unmounts=0;
const ok=value=>({ok:true,value});
class SyntheticRemote extends cordis.Service {
  constructor(ctx){super(ctx,'remote');}
  async $mount(descriptor){assert.equal(descriptor.descriptors.length,6);mounts++;this.ctx.reflect.provide('remote.bluebubblesBindings',{list:async()=>ok({revision:'a'.repeat(64),bindings:[]}),chats:async()=>ok({chats:[],hasMore:false}),sessions:async()=>ok({sessions:[]})});return async()=>unmounts++;}
}
const root=ctx.plugin({apply(ctx){ctx.plugin(renderer);ctx.plugin(SyntheticRemote);}});
await root;
const absent={key:undefined,hooks:{},keyedHooks:{},props:{}};
const absentSource={getSnapshot:()=>absent,subscribe:()=>()=>{}};
const slotOwner=ctx.plugin({inject:['slots'],apply(ctx){
  // Synthetic shell has no active conversation. Public scope adapter makes
  // that absence explicit; settings themselves remain root-scoped.
  ctx.slots.installScope('session',{current:absentSource,bindingSource:()=>absentSource});
  ctx.slots.register({name:'root',children:{'settings.section':{kind:'list',scope:'root'}}},props=>props.renderSlot('settings.section'));
}});
await slotOwner;
const feature=ctx.plugin(entry);
await feature;
assert.equal(mounts,1);
const rows=ctx.slots.entries('settings.section');
assert.equal(rows.length,1);assert.equal(rows[0].options.id,'imessage-bindings');
assert.equal(rows[0].options.label(),'iMessage');
const unrender=ctx.get('uiRenderer').mount(document.getElementById('root'));
for(let count=0;count<100&&!document.body.textContent.includes('尚无绑定');count++)await new Promise(resolve=>setTimeout(resolve,5));
assert.ok(document.body.textContent.includes('iMessage 绑定'));
assert.ok(document.body.textContent.includes('尚无绑定'));
assert.equal(document.querySelectorAll('select').length,2);
unrender();
await feature.dispose();assert.equal(ctx.slots.entries('settings.section').length,0);assert.equal(unmounts,1);
await slotOwner.dispose();await root.dispose();dom.window.close();
console.log(JSON.stringify({targetVersion:version,officialModuleLoader:true,officialSlotRegistry:true,officialSlotRender:true,registeredSettingsSections:1,memoizedImport:true,featureDisposal:true,syntheticTransport:true,liveCalls:0}));
