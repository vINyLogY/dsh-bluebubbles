// Source-port of DeepSeek0.1.1-rc.2 serialize.ts (MIT; see ../NOTICE).
import { LlmError, offloadedImageText, requestImageHandleText } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, GenerateOptions } from '@deepseek-ai/dsh-llm'
import type { Defaults, PreparedImages } from './types.ts'
type Part = {type:'text';text:string} | {type:'file';file_id:string} | {type:'image_url';image_url:{url:string}}
type WireMessage = {role:'system'|'user'|'assistant'|'tool';content:string|Part[];reasoning_content?:string;tool_calls?:{id:string;type:'function';function:{name:string;arguments:string}}[];tool_call_id?:string}
const flatten = (blocks: readonly ContentBlock[]) => blocks.filter(block => block.type === 'text').map(block => block.text).join('')
function thinking(options: GenerateOptions, defaults: Defaults) {
  if (options.purpose === 'session-title') return { thinking: {type:'disabled'} }
  const effort = options.reasoningEffort ?? defaults.reasoningEffort
  if (effort !== undefined && !['off','low','high','max'].includes(effort)) throw new LlmError('unsupported legacy reasoning effort','UNSUPPORTED_REASONING_EFFORT')
  if (defaults.thinking === 'disabled' && effort !== undefined && effort !== 'off') throw new LlmError('thinking disabled for this profile','UNSUPPORTED_REASONING_EFFORT')
  if (effort === 'off') return {thinking:{type:'disabled'}}
  if (effort !== undefined) return {thinking:{type:'enabled'},reasoning_effort:effort}
  return defaults.thinking === undefined ? {} : {thinking:{type:defaults.thinking}}
}
export function serializeRequest(options: GenerateOptions, defaults: Defaults = {}, images?: PreparedImages) {
  const wire: WireMessage[] = []
  let pendingToolImages: Part[] = []
  const flush = () => {
    if (pendingToolImages.length) wire.push({role:'user',content:[{type:'text',text:'Attached image(s) from tool result:'},...pendingToolImages]})
    pendingToolImages = []
  }
  function parts(blocks: readonly ContentBlock[]) {
    const result: Part[] = []
    for (const block of blocks) {
      if (block.type === 'text') { if (block.text.length) result.push({type:'text',text:block.text}); continue }
      if (block.type !== 'image') continue
      if (block.offloaded) { result.push({type:'text',text:offloadedImageText(block.attachment, undefined)}); continue }
      const version = images?.versions.get(block.attachment.attachmentId)
      if (!images || !version) throw new LlmError('request image was not prepared','INVALID_REQUEST')
      result.push({type:'text',text:(result.length ? '\n' : '') + requestImageHandleText(block.attachment,version,undefined)})
      if (images.representation === 'file') {
        const id = images.fileIds?.get(version.variantId)
        if (!id) throw new LlmError('request file ID missing','INVALID_REQUEST')
        result.push({type:'file',file_id:id})
      } else result.push({type:'image_url',image_url:{url:`data:${version.mediaType};base64,${Buffer.from(version.data).toString('base64')}`}})
    }
    return result
  }
  if (options.system !== undefined) wire.push({role:'system',content:options.system})
  for (const message of options.messages) {
    if ((message.role === 'assistant' || message.role === 'system') && message.content.some(block => block.type === 'image')) throw new LlmError('image output/system images unsupported','UNSUPPORTED_CONTENT')
    if (message.role === 'developer') throw new LlmError('developer updates must be projected by LlmRuntime','UNSUPPORTED_CONTENT')
    if (message.role === 'system') { flush(); wire.push({role:'system',content:flatten(message.content)}); continue }
    if (message.role === 'assistant') {
      flush()
      const reasoning = message.content.filter(block => block.type === 'reasoning').map(block => block.text).join('')
      const toolCalls = message.content.filter(block => block.type === 'tool-call').map(block => ({id:block.id,type:'function' as const,function:{name:block.name,arguments:block.arguments}}))
      wire.push({role:'assistant',content:flatten(message.content),...reasoning ? {reasoning_content:reasoning} : {},...toolCalls.length ? {tool_calls:toolCalls} : {}})
      continue
    }
    const content = parts(message.content)
    if (message.role === 'tool') {
      wire.push({role:'tool',tool_call_id:message.toolCallId,content:content.filter(part => part.type === 'text').map(part => part.text).join('') || '(no output)'})
      pendingToolImages.push(...content.filter(part => part.type !== 'text'))
      continue
    }
    flush()
    wire.push({role:'user',content:content.every(part => part.type === 'text') ? content.map(part => part.text).join('') : content})
  }
  flush()
  return {model:options.model,messages:wire,stream:true,stream_options:{include_usage:true},...thinking(options,defaults),
    ...options.tools?.length ? {tools:options.tools.map(tool => ({type:'function',function:{name:tool.name,description:tool.description,parameters:tool.parameters}}))} : {},
    ...options.temperature === undefined ? {} : {temperature:options.temperature},...options.maxTokens === undefined ? {} : {max_tokens:options.maxTokens},...options.stop === undefined ? {} : {stop:options.stop}}
}
