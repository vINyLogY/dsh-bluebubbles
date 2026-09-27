import {build} from 'esbuild';
import {mkdir,writeFile} from 'node:fs/promises';
const result=await build({entryPoints:['src/client.mjs'],bundle:true,write:false,format:'cjs',platform:'browser',target:'es2022',minify:true,external:['react','react/jsx-runtime'],legalComments:'none'});
await mkdir('lib',{recursive:true});
// Minified dependency diagnostics retain whitespace-only lines; normalize
// those lines so the reproducible generated asset passes repository hygiene.
const code=result.outputFiles[0].text.replace(/^[\t ]+$/gm,'');
await writeFile('lib/client.js',`window.__ModuleLoader__.load({id:"@vinylogy/dsh-client-imessage-bindings",factory:(require)=>{var module={exports:{}};var exports=module.exports;\n${code}\nreturn module.exports;}});\n`);
