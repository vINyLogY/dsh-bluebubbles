// The VM is not a security boundary. Treat every child-process frame as untrusted.
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const text = value => typeof value === 'string'
const count = value => Number.isSafeInteger(value) && value >= 0
const id = value => count(value) && value > 0
function shape(value, required, optional = []) {
  if (!object(value) || required.some(key => !Object.hasOwn(value, key)) || Object.keys(value).some(key => !required.includes(key) && !optional.includes(key))) throw new TypeError('invalid legacy workflow protocol shape')
}
export function validateWorkerMessage(message) {
  shape(message, ['type'], ['title', 'message', 'info', 'callId', 'request', 'result'])
  switch (message.type) {
    case 'ready': shape(message, ['type']); break
    case 'phase': shape(message, ['type', 'title']); if (!text(message.title)) throw new TypeError('invalid phase'); break
    case 'log': shape(message, ['type', 'message']); if (!text(message.message)) throw new TypeError('invalid log'); break
    case 'child-dispose': shape(message, ['type', 'callId']); if (!id(message.callId)) throw new TypeError('invalid call id'); break
    case 'child-start': {
      shape(message, ['type', 'callId', 'request']); if (!id(message.callId)) throw new TypeError('invalid call id')
      shape(message.request, ['prompt'], ['schema', 'provider', 'model'])
      if (!text(message.request.prompt) || ['provider', 'model'].some(key => Object.hasOwn(message.request, key) && (!text(message.request[key]) || !message.request[key].trim()))) throw new TypeError('invalid child request')
      if (Object.hasOwn(message.request, 'schema') && !object(message.request.schema)) throw new TypeError('invalid child schema')
      break
    }
    case 'agent-start': case 'agent-end': {
      shape(message, ['type', 'info'])
      shape(message.info, message.type === 'agent-end' ? ['seq', 'label', 'childId', 'outcome'] : ['seq', 'label', 'childId'], ['phase'])
      if (!id(message.info.seq) || !text(message.info.label) || !text(message.info.childId) || !message.info.childId || (Object.hasOwn(message.info, 'phase') && !text(message.info.phase)) || (message.type === 'agent-end' && !['completed', 'failed', 'cancelled'].includes(message.info.outcome))) throw new TypeError('invalid agent info')
      break
    }
    case 'result':
      shape(message, ['type', 'result']); shape(message.result, ['value', 'stopReason', 'agentsStarted'], ['error'])
      if (!count(message.result.agentsStarted) || !['completed', 'cancelled', 'error'].includes(message.result.stopReason) || (Object.hasOwn(message.result, 'error') && !text(message.result.error))) throw new TypeError('invalid result')
      break
    default: throw new TypeError('unknown legacy workflow message')
  }
  return message
}
export function validateTransportFrame(frame) {
  if (!object(frame)) throw new TypeError('invalid transport frame')
  if (frame.type === 'message') { shape(frame, ['type', 'value']); validateWorkerMessage(frame.value) }
  else if (frame.type === 'error' || frame.type === 'messageerror') { shape(frame, ['type', 'message']); if (!text(frame.message)) throw new TypeError('invalid transport error') }
  else if (frame.type === 'exit') { shape(frame, ['type', 'code']); if (!Number.isSafeInteger(frame.code)) throw new TypeError('invalid transport exit') }
  else throw new TypeError('unknown legacy workflow transport frame')
  return frame
}
