import {BindingsState} from './controller.mjs';
import {BindingsPage} from './page.mjs';
import {contribution} from './contribution.mjs';
export const inject=['slots','remote'];
export async function apply(ctx){
  const unmount=await ctx.remote.$mount(contribution);
  const controller=new BindingsState(ctx.get('remote.bluebubblesBindings'));
  ctx.effect(()=>()=>{controller.dispose();return unmount();},'imessage-bindings: remote ownership');
  ctx.slots.inject('settings.section',()=>ctx.slots.register({
    name:'settings.section',id:'imessage-bindings',order:60,label:()=> 'iMessage',inject:()=>({controller}),
  },BindingsPage));
}
