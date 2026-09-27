import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import React from 'react';
import {contribution} from '../src/contribution.mjs';
import {BindingsState} from '../src/controller.mjs';
test('built browser asset follows official ModuleLoader and scoped settings/remote ownership contract',async()=>{
  let loaded;
  const context=vm.createContext({window:{__ModuleLoader__:{load:value=>loaded=value}},console,setTimeout,clearTimeout});
  vm.runInContext(await readFile(new URL('../lib/client.js',import.meta.url),'utf8'),context);
  assert.equal(loaded.id,'@vinylogy/dsh-client-imessage-bindings');
  const entry=loaded.factory(name=>{assert.equal(name,'react');return React;});
  assert.deepEqual(Array.from(entry.inject),['slots','remote']);
  let mounts=0,unmounts=0,controller,slot,component,cleanup;
  const ctx={remote:{$mount:async value=>{assert.equal(value.descriptors.length,6);mounts++;return async()=>unmounts++;}},get:name=>{assert.equal(name,'remote.bluebubblesBindings');return {};},effect:fn=>cleanup=fn(),slots:{inject:(name,fn)=>{assert.equal(name,'settings.section');return fn();},register:(options,view)=>{slot=options;component=view;controller=options.inject().controller;}}};
  await entry.apply(ctx);assert.equal(mounts,1);assert.equal(slot.id,'imessage-bindings');assert.equal(slot.label(),'iMessage');assert.equal(typeof component,'function');assert.equal(typeof controller.load,'function');await cleanup();assert.equal(unmounts,1);assert.equal(controller.listeners.size,0);
});
test('remote methods carry exact public namespace and named args, never HTTP or anonymous CRUD',()=>{
  assert.deepEqual(contribution.descriptors.map(d=>d.method),['list','chats','sessions','bind','unbind','updateRelay']);
  for(const d of contribution.descriptors){assert.equal(d.namespace,'bluebubblesBindings');assert.equal(d.invocation.kind,'direct');assert.equal(d.result.mode,'src-json');for(const p of d.parameters){assert.equal(p.wire,'args');assert.equal(p.codec.mode,'strict');assert.equal(p.codec.create().safeParse({unexpected:true}).success,false);}}
});
test('late mutation after timeout is unknown, never auto-retried/applied; refresh is mandatory',async()=>{
  const ok=value=>({ok:true,value});let resolve,calls=0;
  const state=new BindingsState({bind:()=>{calls++;return new Promise(done=>resolve=done);},list:async()=>ok({revision:'confirmed',bindings:[]}),chats:async()=>ok({chats:[],hasMore:false}),sessions:async()=>ok([])},{timeoutMs:5});
  state.set({loading:false,revision:'before'});assert.equal(await state.mutate('bind',{chatGuid:'synthetic'}),false);assert.equal(state.state.requiresRefresh,true);assert.match(state.state.error,/未确认/);
  assert.equal(await state.mutate('bind',{chatGuid:'synthetic'}),false);assert.equal(calls,1);
  await state.load();assert.equal(state.state.requiresRefresh,false);assert.equal(state.state.revision,'confirmed');
  resolve(ok({revision:'late',bindings:[{chatGuid:'synthetic'}]}));await new Promise(done=>setTimeout(done,0));assert.equal(state.state.revision,'confirmed');assert.equal(state.state.bindings.length,0);state.dispose();
});
test('explicit newer refresh wins over in-flight mutation/page; dispose suppresses async writes',async()=>{
  const ok=value=>({ok:true,value});let mutation,page;
  const state=new BindingsState({bind:()=>new Promise(resolve=>mutation=resolve),list:async()=>ok({revision:'new',bindings:[]}),chats:async args=>args.offset===50?await new Promise(resolve=>page=resolve):ok({chats:[],hasMore:true,nextOffset:50}),sessions:async()=>ok([])});
  await state.load();const pending=state.mutate('bind',{});await new Promise(resolve=>setTimeout(resolve,0));await state.load();mutation(ok({revision:'stale',bindings:[{}]}));assert.equal(await pending,false);assert.equal(state.state.revision,'new');
  const more=state.more();await new Promise(resolve=>setTimeout(resolve,0));await state.load();page(ok({chats:[{guid:'stale'}],hasMore:false}));await more;assert.deepEqual(state.state.chats,[]);
  const discarded=state.mutate('bind',{});await new Promise(resolve=>setTimeout(resolve,0));state.dispose();const before=state.state;mutation(ok({revision:'after-dispose'}));assert.equal(await discarded,false);assert.equal(state.state,before);
});
test('bounded timeout exits loading; stale refresh cannot overwrite new snapshot',async()=>{
  const hung=new BindingsState({list:()=>new Promise(()=>{}),chats:()=>new Promise(()=>{}),sessions:()=>new Promise(()=>{})},{timeoutMs:5});await hung.load();assert.equal(hung.state.loading,false);assert.match(hung.state.error,/未确认/);hung.dispose();
  const ok=value=>({ok:true,value});let firstResolve,lists=0;
  const state=new BindingsState({list:async()=>++lists===1?await new Promise(resolve=>firstResolve=resolve):ok({revision:'new',bindings:[]}),chats:async()=>ok({chats:[],hasMore:false}),sessions:async()=>ok([])});
  const first=state.load();await new Promise(resolve=>setTimeout(resolve,0));await state.load();firstResolve(ok({revision:'old',bindings:[]}));await first;assert.equal(state.state.revision,'new');state.dispose();
});
