export const errors = {
  conflict: '绑定已被其他操作修改。已刷新列表，请确认后重试。',
  busy: '该 session 正在处理任务，请等任务结束后重试。',
  'not-found': '聊天或 session 已不存在，请刷新后重新选择。',
  'preset-unavailable': '该 session 的预设不可恢复，请先修复预设。',
  'session-conflict': '该 session 已绑定其他聊天，请选择另一个 session。',
  'chat-unavailable': '此聊天目前不可用，请刷新聊天列表。',
  'persistence-failed': '保存失败，原绑定未更改。请稍后重试。',
  unavailable: '绑定管理服务未启用或连接不可用，请确认已启用可选的管理插件。',
  'gateway/not-found': '绑定管理服务未启用，请先启用可选的管理插件。',
  timeout: '操作未确认完成。请刷新后检查当前绑定，再重试。',
};
export class BindingsState {
  constructor(api,{timeoutMs=15000}={}) {
    this.api = api; this.listeners = new Set(); this.generation = 0;
    this.timeoutMs=timeoutMs;
    this.state = {loading:true,pending:false,requiresRefresh:false,error:'',bindings:[],chats:[],sessions:[],revision:'',hasMore:false,nextOffset:0};
  }
  subscribe = fn => { this.listeners.add(fn); return () => this.listeners.delete(fn); };
  snapshot = () => this.state;
  set(patch) { this.state = {...this.state,...patch}; for (const fn of this.listeners) fn(); }
  async call(method,args) {
    let timer;
    const result = await Promise.race([
      Promise.resolve().then(()=>this.api[method](...(args === undefined ? [] : [args]))),
      new Promise((_,reject)=>{timer=setTimeout(()=>{const e=new Error('Remote timeout');e.code='timeout';reject(e);},this.timeoutMs);}),
    ]).finally(()=>clearTimeout(timer));
    if (!result?.ok) { const e = new Error('Binding operation failed'); e.code = result?.error?.code; throw e; }
    return result.value;
  }
  message(e) { return errors[e?.code] ?? '无法完成操作。请检查连接并重试。'; }
  async load() {
    const generation = ++this.generation; this.set({loading:true,pending:false,error:''});
    try {
      const [list,page,sessions] = await Promise.all([this.call('list'),this.call('chats',{offset:0,limit:50}),this.call('sessions')]);
      if (generation !== this.generation) return;
      this.set({...list,chats:page.chats,sessions:Array.isArray(sessions)?sessions:sessions.sessions,hasMore:page.hasMore,nextOffset:page.nextOffset,loading:false,requiresRefresh:false});
    } catch(e) { if(generation===this.generation)this.set({loading:false,error:this.message(e)}); }
  }
  async more() {
    if(this.state.pending||!this.state.hasMore)return;
    const generation=this.generation;
    this.set({pending:true,error:''});
    try { const page=await this.call('chats',{offset:this.state.nextOffset,limit:50}); if(generation===this.generation)this.set({chats:[...new Map([...this.state.chats,...page.chats].map(c=>[c.guid,c])).values()],hasMore:page.hasMore,nextOffset:page.nextOffset}); }
    catch(e){if(generation===this.generation)this.set({error:this.message(e)});} finally{if(generation===this.generation)this.set({pending:false});}
  }
  async mutate(method,values) {
    if(this.state.pending||this.state.loading||this.state.requiresRefresh)return false;
    const generation=this.generation;
    this.set({pending:true,error:''});
    try { const list=await this.call(method,{...values,expectedRevision:this.state.revision}); if(generation!==this.generation)return false;this.set(list); return true; }
    catch(e){
      if(generation!==this.generation)return false;
      if(e?.code==='timeout')this.set({requiresRefresh:true});
      if(e?.code==='conflict') { try { const list=await this.call('list');if(generation!==this.generation)return false;this.set(list); } catch {if(generation===this.generation)this.set({requiresRefresh:true,error:'绑定已被修改，刷新也未完成。请检查连接并刷新后重试。'});return false;} }
      this.set({error:this.message(e)}); return false;
    } finally { if(generation===this.generation)this.set({pending:false}); }
  }
  dispose() { this.generation++; this.listeners.clear(); }
}
