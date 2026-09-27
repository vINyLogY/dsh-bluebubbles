import React, {useEffect,useId,useRef,useState,useSyncExternalStore} from 'react';
const h=React.createElement;
export function BindingsPage({controller}) {
  const s=useSyncExternalStore(controller.subscribe,controller.snapshot);
  const id=useId(), chatRef=useRef(null), [chat,setChat]=useState(''), [session,setSession]=useState(''),[relay,setRelay]=useState(true),[confirm,setConfirm]=useState(null);
  useEffect(()=>{void controller.load();},[controller]);
  const locked=s.loading||s.pending;
  const mutationLocked=locked||s.requiresRefresh;
  const chatLabel=c=>c.title?`${c.title}${s.chats.filter(other=>other.title===c.title).length>1?` · ${c.guid.slice(-6)}`:''}`:`未命名聊天${c.participants?.length?`（${c.participants.length} 位参与者）`:''} · ${c.guid.slice(-6)}`;
  const chatName=guid=>s.chats.find(c=>c.guid===guid)?chatLabel(s.chats.find(c=>c.guid===guid)):guid?'未加载的聊天':'旧非聊天路由';
  const sessionLabel=item=>`${item.title||'Session'} · ${s.sessions.some(other=>other.id!==item.id&&other.id.slice(0,8)===item.id.slice(0,8))?item.id:item.id.slice(0,8)}`;
  const sessionStatus=item=>({running:'运行中',idle:'空闲',cold:'未加载',unverified:'待验证'}[item.status]||(item.running?'运行中':''));
  const sessionName=value=>s.sessions.find(item=>item.id===value)?sessionLabel(s.sessions.find(item=>item.id===value)):`Session · ${value.slice(0,8)}`;
  async function submit(e){e.preventDefault();if(!chat||!session||mutationLocked)return; if(await controller.mutate('bind',{chatGuid:chat,sessionId:session,relay})){setChat('');setSession('');chatRef.current?.focus();}}
  return h('section',{'aria-labelledby':`${id}-title`,style:{maxWidth:720,display:'grid',gap:16}},
    h('header',null,h('h2',{id:`${id}-title`},'iMessage 绑定'),h('p',null,'将已有聊天路由到已有 session。这里不会创建 session 或发送消息。')),
    s.error&&h('div',{role:'alert',style:{border:'1px solid currentColor',padding:12}},s.error),
    h('button',{type:'button',disabled:locked,onClick:()=>controller.load()},'刷新'),
    s.loading&&h('p',{role:'status'},'正在加载聊天和绑定…'),
    !s.loading&&h('form',{onSubmit:submit,'aria-busy':s.pending,style:{display:'grid',gap:10}},
      h('label',{htmlFor:`${id}-chat`},'已有聊天'),h('select',{id:`${id}-chat`,ref:chatRef,value:chat,disabled:locked,onChange:e=>setChat(e.target.value)},h('option',{value:''},s.chats.length?'选择聊天':'没有可用聊天'),...s.chats.map(c=>h('option',{key:c.guid,value:c.guid},chatLabel(c)))),
      s.hasMore&&h('button',{type:'button',disabled:locked,onClick:()=>controller.more()},'加载更多聊天'),
      h('label',{htmlFor:`${id}-session`},'已有 session'),h('select',{id:`${id}-session`,value:session,disabled:locked,onChange:e=>setSession(e.target.value)},h('option',{value:''},s.sessions.length?'选择 session':'没有可用 session'),...s.sessions.map(item=>h('option',{key:item.id,value:item.id,disabled:item.available===false},`${sessionLabel(item)}${item.available===false?'（不可恢复）':item.available===undefined?'（保存时验证）':''}${sessionStatus(item)?` · ${sessionStatus(item)}`:''}`))),
      h('small',null,'保存时会验证 session 当前预设是否可恢复；这里不会启动 agent。'),
      h('label',null,h('input',{type:'checkbox',checked:relay,disabled:locked,onChange:e=>setRelay(e.target.checked)}),' 将 agent 回复发送到聊天'),
      h('button',{type:'submit',disabled:mutationLocked||!chat||!session},s.pending?'正在保存…':'绑定到此 session')),
    h('h3',null,'当前绑定'),!s.loading&&!s.bindings.length&&h('p',null,'尚无绑定。请选择聊天和 session。'),
    ...s.bindings.map(row=>h('article',{key:row.key||row.chatGuid,style:{border:'1px solid color-mix(in srgb, currentColor 25%, transparent)',borderRadius:8,padding:14,display:'grid',gap:8}},
      h('h4',{style:{margin:0}},chatName(row.chatGuid)),
      h('p',null,row.sessionId?`固定 session：${sessionName(row.sessionId)}`:'旧 workspace 动态绑定：每次按 workspace 选择最新 session。'),
      row.conflict&&h('p',{role:'status'},'绑定存在冲突，请解除冲突后重试。'),
      row.status==='dangling'&&h('p',{role:'status'},'当前绑定目标不存在或不可解析，请重新绑定。'),
      !row.chatGuid&&h('p',null,'此旧路由不是聊天绑定，不能在此页面更改。'),
      h('label',null,h('input',{type:'checkbox',checked:row.relay,disabled:mutationLocked||!row.chatGuid,onChange:e=>controller.mutate('updateRelay',{chatGuid:row.chatGuid,relay:e.target.checked})}),` 发送回复 · ${chatName(row.chatGuid)}`),
      confirm!==null&&confirm===row.chatGuid?h('div',{onKeyDown:e=>{if(e.key==='Escape'){setConfirm(null);e.currentTarget.parentElement.querySelector('[data-unbind]')?.focus();}}},h('p',null,'仅解除路由，不删除聊天或 session。'),h('button',{type:'button',autoFocus:true,disabled:locked,onClick:async()=>{if(await controller.mutate('unbind',{chatGuid:row.chatGuid})) {setConfirm(null);chatRef.current?.focus();}}},'确认解绑'),h('button',{type:'button',disabled:locked,onClick:e=>{setConfirm(null);e.currentTarget.parentElement.parentElement.querySelector('[data-unbind]')?.focus();}},'取消')):null,
      h('button',{'data-unbind':true,type:'button',disabled:mutationLocked||!row.chatGuid,onClick:()=>setConfirm(row.chatGuid),'aria-label':`解绑 ${chatName(row.chatGuid)}`},'解绑'))),
    h('p',{role:'status','aria-live':'polite'},s.pending?'正在保存，请勿重复提交。':''));
}
