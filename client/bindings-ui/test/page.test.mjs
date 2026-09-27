import {test,beforeEach,afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import React from 'react';
const dom=new JSDOM('<!doctype html><html><body></body></html>',{url:'http://synthetic.invalid'});
Object.assign(globalThis,{window:dom.window,document:dom.window.document,HTMLElement:dom.window.HTMLElement,MutationObserver:dom.window.MutationObserver});
Object.defineProperty(globalThis,'navigator',{value:dom.window.navigator,configurable:true});
const {render,screen,cleanup,waitFor}=await import('@testing-library/react');
const {default:userEvent}=await import('@testing-library/user-event');
const {BindingsPage}=await import('../src/page.mjs');
const {BindingsState}=await import('../src/controller.mjs');
const revision='a'.repeat(64), nextRevision='b'.repeat(64);
let calls,api,controller,user;
const ok=value=>({ok:true,value});
beforeEach(()=>{
  calls=[];user=userEvent.setup({document});
  api={list:async()=>ok({revision,bindings:[]}),chats:async()=>ok({chats:[{guid:'synthetic-chat-a',title:'Example group'},{guid:'synthetic-chat-b',title:'Example DM'}],hasMore:false}),sessions:async()=>ok([{id:'synthetic-session-a',title:'Research',available:true},{id:'synthetic-session-b',title:'Unavailable',available:false}]),bind:async args=>{calls.push(['bind',args]);return ok({revision:nextRevision,bindings:[{chatGuid:args.chatGuid,sessionId:args.sessionId,relay:args.relay}]});},unbind:async args=>{calls.push(['unbind',args]);return ok({revision:nextRevision,bindings:[]});},updateRelay:async args=>{calls.push(['relay',args]);return ok({revision:nextRevision,bindings:[{chatGuid:args.chatGuid,workspacePath:'/synthetic/workspace',relay:args.relay}]});}};
  controller=new BindingsState(api);
});
afterEach(()=>{controller.dispose();cleanup();});
function view(){render(React.createElement(BindingsPage,{controller}));}
async function loaded(){await screen.findByLabelText('已有聊天');}
test('loading, empty state, labelled keyboard bind preserves exact session ID and focus',async()=>{
  view();assert.ok(screen.getByText('正在加载聊天和绑定…'));await loaded();
  assert.ok(screen.getByText('尚无绑定。请选择聊天和 session。'));
  await user.selectOptions(screen.getByLabelText('已有聊天'),'synthetic-chat-a');
  await user.selectOptions(screen.getByLabelText('已有 session'),'synthetic-session-a');
  const bind=screen.getByRole('button',{name:'绑定到此 session'});bind.focus();await user.keyboard('{Enter}');
  await waitFor(()=>assert.equal(calls.length,1));
  assert.deepEqual(calls[0],['bind',{chatGuid:'synthetic-chat-a',sessionId:'synthetic-session-a',relay:true,expectedRevision:revision}]);
  await waitFor(()=>assert.equal(document.activeElement,screen.getByLabelText('已有聊天')));
  assert.ok(screen.getByText('固定 session：Research · synthetic-session-a'));
  assert.equal(screen.getByRole('option',{name:'Unavailable · synthetic-session-b（不可恢复）'}).disabled,true);
});
test('legacy workspace relay update never converts to a fixed session',async()=>{
  api.list=async()=>ok({revision,bindings:[{chatGuid:'synthetic-chat-a',workspacePath:'/synthetic/workspace',relay:true}]});view();await loaded();
  assert.ok(screen.getByText(/旧 workspace 动态绑定/));
  await user.click(screen.getByLabelText('发送回复 · Example group'));
  await waitFor(()=>assert.equal(calls.length,1));
  assert.deepEqual(calls[0],['relay',{chatGuid:'synthetic-chat-a',relay:false,expectedRevision:revision}]);
  assert.equal(screen.getByLabelText('发送回复 · Example group').checked,false);
  assert.ok(screen.getByText(/旧 workspace 动态绑定/));
});
test('unbind asks confirmation, Escape restores control, confirmed removal does not delete session',async()=>{
  api.list=async()=>ok({revision,bindings:[{chatGuid:'synthetic-chat-a',sessionId:'synthetic-session-a',relay:true}]});view();await loaded();
  const button=screen.getByRole('button',{name:'解绑 Example group'});await user.click(button);
  screen.getByRole('button',{name:'确认解绑'}).focus();await user.keyboard('{Escape}');
  assert.equal(screen.queryByRole('button',{name:'确认解绑'}),null);assert.equal(document.activeElement,button);assert.equal(calls.length,0);
  await user.click(button);await user.click(screen.getByRole('button',{name:'确认解绑'}));
  await waitFor(()=>assert.equal(calls.length,1));assert.deepEqual(calls[0],['unbind',{chatGuid:'synthetic-chat-a',expectedRevision:revision}]);
});
test('revision conflict refreshes authoritative list and preserves unsaved selection',async()=>{
  api.bind=async()=>({ok:false,error:{code:'conflict',message:'secret must not render'}});view();await loaded();
  await user.selectOptions(screen.getByLabelText('已有聊天'),'synthetic-chat-a');await user.selectOptions(screen.getByLabelText('已有 session'),'synthetic-session-a');
  api.list=async()=>ok({revision:nextRevision,bindings:[]});await user.click(screen.getByRole('button',{name:'绑定到此 session'}));
  assert.match((await screen.findByRole('alert')).textContent,/已刷新/);assert.equal(screen.getByLabelText('已有聊天').value,'synthetic-chat-a');assert.equal(screen.getByLabelText('已有 session').value,'synthetic-session-a');assert.equal(controller.state.revision,nextRevision);assert.equal(document.body.textContent.includes('secret'),false);
});
test('busy/save failure is not optimistic success; pending rejects duplicate submission',async()=>{
  let settle;api.bind=async args=>{calls.push(args);return await new Promise(resolve=>settle=resolve);};view();await loaded();
  await user.selectOptions(screen.getByLabelText('已有聊天'),'synthetic-chat-a');await user.selectOptions(screen.getByLabelText('已有 session'),'synthetic-session-a');
  await user.click(screen.getByRole('button',{name:'绑定到此 session'}));assert.equal(screen.getByRole('button',{name:'正在保存…'}).disabled,true);
  assert.equal(await controller.mutate('bind',{}),false);assert.equal(calls.length,1);
  settle({ok:false,error:{code:'busy'}});assert.match((await screen.findByRole('alert')).textContent,/正在处理任务/);assert.equal(controller.state.bindings.length,0);
  api.bind=async()=>({ok:false,error:{code:'persistence-failed'}});await user.click(screen.getByRole('button',{name:'绑定到此 session'}));assert.match((await screen.findByRole('alert')).textContent,/保存失败/);assert.equal(controller.state.bindings.length,0);
});
test('connection failure retry and preset failure use safe understandable messages',async()=>{
  api.list=async()=>{throw Error('private token');};view();assert.match((await screen.findByRole('alert')).textContent,/检查连接/);assert.equal(document.body.textContent.includes('private token'),false);
  api.list=async()=>ok({revision,bindings:[]});await user.click(screen.getByRole('button',{name:'刷新'}));await loaded();
  await user.selectOptions(screen.getByLabelText('已有聊天'),'synthetic-chat-a');await user.selectOptions(screen.getByLabelText('已有 session'),'synthetic-session-a');api.bind=async()=>({ok:false,error:{code:'preset-unavailable'}});await user.click(screen.getByRole('button',{name:'绑定到此 session'}));assert.match((await screen.findByRole('alert')).textContent,/预设不可恢复/);
});
test('load more finds chats beyond first page; same-name sessions remain distinguishable',async()=>{
  api.chats=async args=>ok(args.offset===0?{chats:[{guid:'synthetic-first',title:'Example first'}],hasMore:true,nextOffset:50}:{chats:[{guid:'synthetic-later',title:'Example later'}],hasMore:false,nextOffset:51});
  api.sessions=async()=>ok([{id:'sameprefix-one',title:'Same name',available:true},{id:'sameprefix-two',title:'Same name',available:true}]);view();await loaded();
  assert.ok(screen.getByRole('option',{name:'Same name · sameprefix-one'}));assert.ok(screen.getByRole('option',{name:'Same name · sameprefix-two'}));
  await user.click(screen.getByRole('button',{name:'加载更多聊天'}));await screen.findByRole('option',{name:'Example later'});
  await user.selectOptions(screen.getByLabelText('已有聊天'),'synthetic-later');await user.selectOptions(screen.getByLabelText('已有 session'),'sameprefix-two');await user.click(screen.getByRole('button',{name:'绑定到此 session'}));
  await waitFor(()=>assert.equal(calls.length,1));assert.equal(calls[0][1].chatGuid,'synthetic-later');assert.equal(calls[0][1].sessionId,'sameprefix-two');assert.equal(screen.queryByRole('button',{name:'加载更多聊天'}),null);
});
