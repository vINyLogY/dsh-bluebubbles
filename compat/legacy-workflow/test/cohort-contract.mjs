import fs from 'node:fs/promises'
import path from 'node:path'
import assert from 'node:assert/strict'
import {createRequire}from'node:module'

/** Compare every actual first-party import in a candidate's local source graph
 * with the host's exact physical package, not merely its version string. */
export async function assertCohort(entry,hostManifest){
 const host=createRequire(hostManifest),seen=new Set(),checks=[]
 async function visit(file){file=await fs.realpath(file);if(seen.has(file))return;seen.add(file);const text=await fs.readFile(file,'utf8'),from=createRequire(file)
  const specs=new Set()
  for(const line of text.split('\n')){
   if(/^\s*import\s+type\b/.test(line))continue
   for(const match of line.matchAll(/(?:\bfrom\s*|\bimport\s*\(|\brequire\s*\(|^\s*import\s*)['"]([^'"]+)['"]/g))specs.add(match[1])
  }
  for(const spec of specs){if(spec.startsWith('@deepseek-ai/')){const candidate=await fs.realpath(from.resolve(spec)),target=await fs.realpath(host.resolve(spec));assert.equal(candidate,target,`Physical SDK cohort mismatch for ${spec}`);const pkg=spec.split('/').slice(0,2).join('/');let version;try{version=JSON.parse(await fs.readFile(host.resolve(pkg+'/package.json'))).version}catch{version='package-json-export-unavailable'}checks.push({specifier:spec,package:pkg,version,hostIdentityEqual:true,realpath:candidate})}else if(spec.startsWith('.')){let resolved;try{resolved=from.resolve(spec)}catch{throw Error('UNRESOLVED_LOCAL_IMPORT')};if(/\.(?:[cm]?js|ts)$/.test(resolved))await visit(resolved)}}
 }
 await visit(entry);assert.ok(checks.length>0,'No first-party runtime imports found')
 return{pass:true,localSourceFilesVisited:seen.size,actualImportEdgesChecked:checks.length,packages:[...new Set(checks.map(x=>x.package))],checks}
}
if(process.argv[1]&&path.resolve(process.argv[1])===path.resolve(new URL(import.meta.url).pathname)){const[entry,host]=process.argv.slice(2);console.log(JSON.stringify(await assertCohort(entry,host)))}
