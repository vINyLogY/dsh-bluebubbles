import { EventEmitter } from 'node:events'
import { snapshotJsonValue } from '@deepseek-ai/dsh-util-values'
import { validateTransportFrame } from './protocol.mjs'

// Trusted bridge only. The legacy inner VM and its six DSL globals are unchanged.
// No host Context, Session, capability object, credential, or arbitrary env crosses IPC.
const PROGRAM = `
const { Worker } = await import('node:worker_threads');
const init = await legacyWorkflowHost.begin({});
const worker = new Worker(init.entry, { workerData: init.workerData, env: init.env, execArgv: [] });
let finished = false;
let outbound = Promise.resolve();
const done = Promise.withResolvers();
const publish = value => { outbound = outbound.then(() => legacyWorkflowHost.publish(value)); outbound.catch(error => { done.reject(error); void worker.terminate(); }); };
worker.on('message', value => publish({ type: 'message', value }));
worker.on('error', error => publish({ type: 'error', message: String(error.message) }));
worker.on('messageerror', error => publish({ type: 'messageerror', message: String(error.message) }));
worker.on('exit', code => { finished = true; publish({ type: 'exit', code }); outbound.then(() => done.resolve(null), done.reject); });
const inbound = (async () => { while (!finished) { const item = await legacyWorkflowHost.receive({}); if (item.type === 'closed') break; worker.postMessage(item.value); } })();
inbound.catch(error => { done.reject(error); void worker.terminate(); });
try { return await done.promise; } finally { finished = true; await worker.terminate(); }
`

function json(value) {
  const snapshot = snapshotJsonValue(value)
  if (snapshot === undefined) throw new TypeError('legacy workflow IPC requires lossless JSON')
  return snapshot
}

/** Worker-shaped transport whose execution lives ONLY inside the public sandbox runner. */
export class PtcWorker extends EventEmitter {
  controller = new AbortController()
  queue = []
  waiter
  closed = false
  exitEmitted = false
  protocolBytes = 0
  protocolEvents = 0
  constructor(entry, options, runtime, policy) {
    super()
    if (runtime?.language !== 'typescript' || runtime?.isolation !== 'process') throw new TypeError('legacy workflow requires the sandboxed Node TypeScript process PTC runtime')
    if (!policy?.workspaceRoot || !['read-only', 'workspace-write', 'danger-full-access'].includes(policy.mode)) throw new TypeError('legacy workflow requires an authoritative sandbox policy')
    const init = json({ entry, workerData: structuredClone(options.workerData), env: options.env })
    this.maxProtocolBytes = init.workerData.limits.maxProtocolBytes
    this.maxProtocolEvents = init.workerData.limits.maxProtocolEvents
    this.done = Promise.resolve().then(async () => {
      try {
        const spec = runtime.resolve({
          program: PROGRAM,
          bindings: [{ global: 'legacyWorkflowHost', functions: {
            begin: () => Promise.resolve(init),
            receive: () => this.receive(),
            publish: async value => {
              const frame = validateTransportFrame(json(value))
              this.account(frame)
              if (frame.type === 'message') this.emit('message', frame.value)
              else if (frame.type === 'error' || frame.type === 'messageerror') this.emit(frame.type, new Error(frame.message))
              else if (frame.type === 'exit' && Number.isInteger(frame.code)) this.exit(frame.code)
              else throw new TypeError('unknown legacy workflow transport frame')
              return null
            },
          } }],
          cwd: policy.workspaceRoot,
          sandboxPolicy: policy,
          signal: this.controller.signal,
        })
        if (!Number.isFinite(spec.timeoutMs) || spec.timeoutMs <= 0) throw new TypeError('legacy workflow requires a finite PTC execution deadline')
        const outcome = await runtime.run(spec)
        if (outcome.error && !this.controller.signal.aborted) this.emit('error', new Error('sandboxed legacy workflow process failed: ' + outcome.error.kind))
      } catch (error) {
        if (!this.controller.signal.aborted) this.emit('error', error)
      } finally {
        this.closeReceive()
        this.exit(this.controller.signal.aborted ? 1 : 0)
      }
    })
  }
  postMessage(value) {
    if (this.closed) return
    const frame = json({ type: 'message', value })
    this.account(frame)
    if (this.waiter) { const waiter = this.waiter; this.waiter = undefined; waiter(frame) }
    else this.queue.push(frame)
  }
  account(frame) {
    this.protocolBytes += Buffer.byteLength(JSON.stringify(frame))
    this.protocolEvents++
    if (this.protocolBytes > this.maxProtocolBytes || this.protocolEvents > this.maxProtocolEvents) {
      this.closeReceive()
      this.controller.abort('legacy workflow protocol budget exceeded')
      this.emit('error', new Error('legacy workflow protocol budget exceeded'))
      throw new TypeError('legacy workflow protocol budget exceeded')
    }
  }
  receive() {
    if (this.queue.length) return Promise.resolve(this.queue.shift())
    if (this.closed) return Promise.resolve({ type: 'closed' })
    if (this.waiter) throw new Error('legacy workflow transport has two pending receives')
    return new Promise(resolve => { this.waiter = resolve })
  }
  closeReceive() {
    this.closed = true
    this.queue.length = 0
    this.waiter?.({ type: 'closed' })
    this.waiter = undefined
  }
  exit(code) {
    if (this.exitEmitted) return
    this.exitEmitted = true
    this.closeReceive()
    this.emit('exit', code)
  }
  async terminate() {
    this.closeReceive()
    this.controller.abort('legacy workflow transport terminated')
    await this.done
    return 1
  }
}
