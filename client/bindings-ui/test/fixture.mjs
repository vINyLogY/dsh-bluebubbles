// Synthetic screenshot fixture only. No fetch, gateway, storage, or provider.
import React from 'react';
import {createRoot} from 'react-dom/client';
import {BindingsPage} from '../src/page.mjs';
import {BindingsState} from '../src/controller.mjs';
const ok=value=>Promise.resolve({ok:true,value});
const data={revision:'a'.repeat(64),bindings:[{chatGuid:'example-group',sessionId:'research-01',relay:true,status:'bound'},{chatGuid:'example-dm',workspacePath:'/synthetic/project',relay:false,status:'bound'}]};
const controller=new BindingsState({list:()=>ok(data),chats:()=>ok({chats:[{guid:'example-group',title:'Example group',participants:['Example person']},{guid:'example-dm',title:'Example DM',participants:['Example person']}],hasMore:false}),sessions:()=>ok([{id:'research-01',title:'Research session',available:true},{id:'notes-02',title:'Notes session',available:true}]),bind:()=>ok(data),unbind:()=>ok(data),updateRelay:()=>ok(data)});
createRoot(document.getElementById('root')).render(React.createElement(BindingsPage,{controller}));
