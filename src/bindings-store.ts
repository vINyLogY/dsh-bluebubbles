// One canonical JSON file, shared by the host and bb-channel. No second settings store.
import { createHash, randomUUID } from 'node:crypto'
import { dirname } from 'node:path'
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises'
import { acquireBindingsLock } from './bindings-lock.mjs'
import { setTimeout as delay } from 'node:timers/promises'

export interface BindingRecord {
  sessionId?: string
  workspacePath?: string
  relay?: boolean
  typing?: boolean
  [key: string]: unknown
}
export type BindingTable = Record<string, BindingRecord>
export interface BindingSnapshot { revision: string; bindings: BindingTable }
export class BindingError extends Error {
  code: string
  constructor(code: string) { super(code); this.code = code }
}
const revision = (bytes: string) => createHash('sha256').update(bytes).digest('hex')
export async function readBindings(path: string): Promise<BindingSnapshot> {
  let bytes: string
  try { bytes = await readFile(path, 'utf8') }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new BindingError('persistence-failed'); bytes = '{}' }
  let table: unknown
  try { table = JSON.parse(bytes) } catch { throw new BindingError('invalid-store') }
  if (!table || typeof table !== 'object' || Array.isArray(table) || Object.values(table).some(row => !row || typeof row !== 'object' || Array.isArray(row))) throw new BindingError('invalid-store')
  return { revision: revision(bytes), bindings: table as BindingTable }
}

/** Lease the canonical association through the final transport admission.
 * Repository CLI mutations cannot change it while an already-admitted send runs. */
export async function withBindingsLock<T>(path: string, operation: (snapshot: BindingSnapshot) => Promise<T>, waitMs = 0): Promise<T> {
  let release: () => Promise<void>
  const deadline = performance.now() + waitMs
  for (;;) {
    try {
      release = await acquireBindingsLock(path)
      if (waitMs > 0 && performance.now() >= deadline) {
        await release()
        throw new BindingError('lock-timeout')
      }
      break
    }
    catch (error) {
      const code = (error as {code?:string}).code ?? 'lock-unavailable'
      if (code !== 'busy' || waitMs === 0) throw new BindingError(code)
      const remaining = deadline - performance.now()
      if (remaining <= 0) throw new BindingError('lock-timeout')
      await delay(Math.min(25, remaining))
      if (performance.now() >= deadline) throw new BindingError('lock-timeout')
    }
  }
  try { return await operation(await readBindings(path)) } finally { await release() }
}

/** All repository writers serialize here. Arbitrary editors must still honor CAS;
 * an editor ignoring our lock can race the final rename, so is not supported. */
export async function updateBindings(
  path: string, expectedRevision: string | undefined,
  change: (table: BindingTable) => void | Promise<void>,
  publishBoundary: (publish: () => Promise<BindingSnapshot>) => Promise<BindingSnapshot> = publish => publish(),
): Promise<BindingSnapshot> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const temporary = path + '.tmp-' + randomUUID()
  let release: () => Promise<void>
  try { release = await acquireBindingsLock(path) }
  catch (error) { throw new BindingError((error as {code?:string}).code ?? 'lock-unavailable') }
  try {
    const before = await readBindings(path)
    if (expectedRevision !== undefined && expectedRevision !== before.revision) throw new BindingError('conflict')
    await change(before.bindings)
    return await publishBoundary(async () => {
      const bytes = JSON.stringify(before.bindings, null, 2)
      const file = await open(temporary, 'wx', 0o600)
      try { await file.writeFile(bytes); await file.sync() } finally { await file.close() }
      // Catch an external writer that does not participate in our lock before publication.
      const current = await readBindings(path)
      const originalRevision = expectedRevision ?? before.revision
      if (current.revision !== originalRevision) throw new BindingError('conflict')
      await rename(temporary, path)
      return { revision: revision(bytes), bindings: before.bindings }
    })
  } catch (error) {
    if (error instanceof BindingError) throw error
    throw new BindingError('persistence-failed')
  } finally {
    try { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error }) }
    finally { await release() }
  }
}
