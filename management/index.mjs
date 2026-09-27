// Optional DSH 0.1.7 host entry. Never imported by the legacy bridge entry.
import { TypertRemoteService, Remote, RemoteError } from '@deepseek-ai/dsh-typert-protocol'

const initializers = []
const methods = ['list', 'chats', 'sessions', 'bind', 'unbind', 'updateRelay']
function request(value, allowed) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !allowed.includes(key))) throw new RemoteError('invalid-request', 'Invalid binding request')
  return value
}
function identifier(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 512 || /[\u0000-\u001f]/.test(value)) throw new RemoteError('invalid-request', 'Invalid identifier')
  return value
}
export class BindingsController extends TypertRemoteService {
  static inject = ['bluebubbles']
  constructor(ctx) {
    super(ctx, 'bluebubblesBindings')
    for (const initialize of initializers) initialize.call(this)
  }
  async call(method, args) {
    try { return await this.ctx.get('bluebubbles').bindingManagement[method](args) }
    catch (error) {
      const known = ['conflict', 'busy', 'not-found', 'preset-unavailable', 'persistence-failed', 'invalid-store', 'session-conflict', 'chat-unavailable', 'lock-unavailable']
      throw new RemoteError(known.includes(error?.code) ? error.code : 'unavailable', 'Binding operation could not complete')
    }
  }
  list() { return this.call('list') }
  sessions() { return this.call('sessions') }
  chats(args = {}) {
    request(args, ['limit', 'offset'])
    for (const [key, value] of Object.entries(args)) if (!Number.isInteger(value) || value < (key === 'limit' ? 1 : 0) || value > (key === 'limit' ? 100 : 100000)) throw new RemoteError('invalid-request', 'Invalid page')
    return this.call('chats', args)
  }
  bind(args) {
    request(args, ['chatGuid', 'sessionId', 'relay', 'expectedRevision'])
    identifier(args.chatGuid); identifier(args.sessionId)
    if (typeof args.relay !== 'boolean' || typeof args.expectedRevision !== 'string' || !/^[a-f0-9]{64}$/.test(args.expectedRevision)) throw new RemoteError('invalid-request', 'Invalid binding options')
    return this.call('bind', args)
  }
  unbind(args) {
    request(args, ['chatGuid', 'expectedRevision'])
    identifier(args.chatGuid)
    if (typeof args.expectedRevision !== 'string' || !/^[a-f0-9]{64}$/.test(args.expectedRevision)) throw new RemoteError('invalid-request', 'Invalid revision')
    return this.call('unbind', args)
  }
  updateRelay(args) {
    request(args, ['chatGuid', 'relay', 'expectedRevision'])
    identifier(args.chatGuid)
    if (typeof args.relay !== 'boolean' || typeof args.expectedRevision !== 'string' || !/^[a-f0-9]{64}$/.test(args.expectedRevision)) throw new RemoteError('invalid-request', 'Invalid binding options')
    return this.call('updateRelay', args)
  }
}
// Apply the public standard-decorator initializer protocol without TS transforms.
for (const name of methods) Remote(name)(BindingsController.prototype[name], {kind: 'method', name, static: false, private: false, addInitializer(fn) { initializers.push(fn) }})
export const inject = ['bluebubbles', 'connection', 'typertGateway']
export function apply(ctx) { ctx.plugin(BindingsController) }
