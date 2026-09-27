// Public native POSIX lease; the kernel releases ownership even on SIGKILL.
// Keep the carrier inode permanently. Removing it forfeits writer exclusion.
import { open, stat, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import { tryLockExclusive } from '@deepseek-ai/node-addon-system/flock'

export class BindingLockError extends Error {
  /** @param {string} code */
  constructor(code) { super(code); this.code = code }
}

/** @param {string} path @returns {Promise<() => Promise<void>>} */
export async function acquireBindingsLock(path) {
  if (process.platform !== 'darwin' && process.platform !== 'linux') throw new BindingLockError('lock-unavailable')
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  for (let attempt = 0; attempt < 3; attempt++) {
    const file = await open(path + '.lock', 'a', 0o600).catch(() => { throw new BindingLockError('lock-unavailable') })
    try {
      await tryLockExclusive(file.fd)
      const held = await file.stat({ bigint: true })
      const current = await stat(path + '.lock', { bigint: true }).catch(error => {
        if (error.code === 'ENOENT') return undefined
        throw error
      })
      if (current?.dev === held.dev && current?.ino === held.ino) {
        let released = false
        return async () => { if (!released) { released = true; await file.close() } }
      }
    } catch (error) {
      await file.close()
      const code = /** @type {{code?:string}} */ (error).code
      throw new BindingLockError(code === 'EAGAIN' || code === 'EWOULDBLOCK' ? 'busy' : 'lock-unavailable')
    }
    await file.close()
  }
  throw new BindingLockError('busy')
}
