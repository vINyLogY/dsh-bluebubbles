import test from 'node:test'
import assert from 'node:assert/strict'
import {createRequire} from 'node:module'
import {join} from 'node:path'
const legacy=process.env.DSH_LEGACY_NODE_MODULES
assert.ok(legacy,'DSH_LEGACY_NODE_MODULES is required for the old persona oracle')
const nextRequire=createRequire(import.meta.url),oldRequire=createRequire(join(legacy,'oracle.cjs'))
async function assemble(require,complete,includeRuntimeContext,modern){
 const {Context}=await import(require.resolve('@deepseek-ai/cordis'))
 const prompt=await import(require.resolve('@deepseek-ai/dsh-system-prompt'))
 const persona=await import(require.resolve('@deepseek-ai/dsh-persona'))
 const {createScope}=await import(require.resolve('@deepseek-ai/dsh-scope'))
 const ctx=new Context(),fiber=ctx.plugin(prompt.default,{includeHarnessIdentity:false}),key={}
 await fiber
 ctx.systemPrompt.context({name:'synthetic-runtime',order:0,text:'synthetic runtime'})
 const scope=createScope(ctx,key)
 try{
  const original={text:'synthetic persona',complete,includeRuntimeContext}
  const config=modern?{prefix:original.text,suffix:'',complete,includeRuntimeContext}:original
  const plugin=scope.ctx.plugin(persona,config);await plugin
  const assembly=await ctx.systemPrompt.assemble({scope:key})
  return {prompt:prompt.renderPrompt(assembly),contexts:assembly.contexts,tools:assembly.tools,variables:assembly.variables}
 }finally{await scope.dispose();await fiber.dispose()}
}
test('exact legacy text-to-prefix conversion preserves scoped persona prompt and runtime-context policy',async()=>{
 for(const complete of [false,true])for(const includeRuntimeContext of [false,true])assert.deepEqual(await assemble(nextRequire,complete,includeRuntimeContext,true),await assemble(oldRequire,complete,includeRuntimeContext,false))
})
