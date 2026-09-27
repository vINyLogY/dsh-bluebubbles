import assert from 'node:assert/strict'
import test from 'node:test'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import fsPromises, { mkdtemp, mkdir, readFile, rm, stat, rename } from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { acquireBindingsLock } from '../src/bindings-lock.mjs'
import { updateBindings, readBindings } from '../src/bindings-store.ts'

// Real kernel locks and real disposable Node processes; no provider, network,
// credentials, live home, or production file is touched.
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-binding-lock-crash-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  return { root, path: join(root, 'bindings.json') }
}
async function childLease(t, path) {
  const helper = new URL('../src/bindings-lock.mjs', import.meta.url).href
  const program = `import {acquireBindingsLock} from ${JSON.stringify(helper)};
    try { const release=await acquireBindingsLock(process.argv[1]);
      process.send({locked:true});
      process.on('message',async()=>{await release();process.disconnect();});
    } catch(error) {process.send({locked:false,code:error.code});process.disconnect();}`
  const child = spawn(process.execPath, ['--input-type=module', '-e', program, path],
    { env: {}, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] })
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const exit = once(child, 'exit'); child.kill('SIGKILL'); await exit
    }
  })
  const ready = await Promise.race([
    once(child, 'message').then(([message]) => message),
    once(child, 'exit').then(() => { throw new Error('synthetic lock child exited before admission') }),
  ])
  assert.equal(ready.locked, true, 'actual native lease admission must succeed')
  return child
}

test('a live process owns the lease until actual SIGKILL; a new process then acquires', { timeout: 10000 }, async t => {
  const { path } = await fixture(t)
  const first = await childLease(t, path)
  await assert.rejects(acquireBindingsLock(path), error => error.code === 'busy')
  const before = await stat(path + '.lock', { bigint: true })
  const dead = once(first, 'exit'); first.kill('SIGKILL'); await dead
  const second = await childLease(t, path)
  const after = await stat(path + '.lock', { bigint: true })
  assert.equal(after.ino, before.ino)
  assert.equal(after.dev, before.dev)
  const done = once(second, 'exit'); second.send({ release: true }); await done
  const release = await acquireBindingsLock(path); await release()
})

test('a crashed lease does not block a new canonical binding mutation', { timeout: 10000 }, async t => {
  const { path } = await fixture(t)
  await updateBindings(path, undefined, table => { table['chat:A'] = { sessionId: 'S1' } })
  const first = await childLease(t, path)
  const dead = once(first, 'exit'); first.kill('SIGKILL'); await dead
  const before = await readBindings(path)
  await updateBindings(path, before.revision, table => { table['chat:A'].relay = true })
  assert.deepEqual((await readBindings(path)).bindings, { 'chat:A': { sessionId: 'S1', relay: true } })
})

test('same-process separate descriptors contend, then close releases without unlinking carrier', async t => {
  const { path } = await fixture(t)
  const release = await acquireBindingsLock(path)
  await assert.rejects(acquireBindingsLock(path), error => error.code === 'busy')
  await release()
  assert.equal((await stat(path + '.lock')).isFile(), true)
  const next = await acquireBindingsLock(path); await next()
})

test('a former directory-lock carrier is refused without deleting or modifying it', async t => {
  const { path } = await fixture(t)
  await mkdir(path + '.lock', { mode: 0o700 })
  await assert.rejects(acquireBindingsLock(path))
  assert.equal((await stat(path + '.lock')).isDirectory(), true)
  await assert.rejects(readFile(path + '.lock'))
})

test('replacement during admission cannot return a lease on an orphaned carrier', { timeout: 10000 }, async t => {
  const { path } = await fixture(t)
  const actualStat = fsPromises.stat
  let replacement, changed = false
  // Deterministically introduce the real rename in the exact native-acquire
  // to pathname-validation window. Both owners still use actual native flock.
  fsPromises.stat = async (...args) => {
    if (args[0] === path + '.lock' && !changed) {
      changed = true
      await rename(path + '.lock', path + '.orphan')
      replacement = await childLease(t, path)
    }
    return actualStat(...args)
  }
  syncBuiltinESMExports()
  let result
  try { result = await acquireBindingsLock(path).catch(error => error) }
  finally { fsPromises.stat = actualStat; syncBuiltinESMExports() }
  if (typeof result === 'function') { await result(); assert.fail('orphaned inode was incorrectly admitted') }
  assert.equal(changed, true)
  assert.equal(result.code, 'busy')
  const exited = once(replacement, 'exit'); replacement.send({ release: true }); await exited
  const next = await acquireBindingsLock(path); await next()
})

test('native loading failure is fail-closed and leaves no held descriptor', { timeout: 10000 }, async t => {
  const { path } = await fixture(t)
  const helper = new URL('../src/bindings-lock.mjs', import.meta.url).href
  // The real addon resolver cannot find this synthetic architecture. No real
  // installed package is renamed, removed, or replaced for this negative case.
  const program = `import {acquireBindingsLock} from ${JSON.stringify(helper)};
    Object.defineProperty(process,'arch',{value:'synthetic-missing-native'});
    try { const release=await acquireBindingsLock(process.argv[1]);await release();process.send({unexpectedSuccess:true}); }
    catch(error) {process.send({code:error.code});}process.disconnect();`
  const child = spawn(process.execPath, ['--input-type=module', '-e', program, path], { env: {}, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] })
  const done = once(child, 'exit')
  const [result] = await once(child, 'message'); await done
  assert.equal(result.code, 'lock-unavailable')
  const release = await acquireBindingsLock(path); await release()
})
