import { LlmAdapter, LlmError, ProviderRequestId, ReasoningEffortId, attributionHeaders, contentHasImage, isContextWindowExceededError, isQuotaExceededError, requiredImageOffload, QUOTA_EXCEEDED_CODE, CONTEXT_WINDOW_EXCEEDED_CODE, IMAGE_OFFLOAD_REQUIRED_CODE, assertUsableApiKey } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk, LlmResolvedModelInfo, PreparedAdapterCall } from '@deepseek-ai/dsh-llm'
import { requestImageDimensions } from '@deepseek-ai/dsh-attachment'
import type { RequestImageAttachment } from '@deepseek-ai/dsh-attachment'
import { deadline, idleWatchdog, timeoutOf } from '@deepseek-ai/dsh-timeout'
import { resolveOptions } from './config.ts'
import { serializeRequest } from './wire.ts'
import { parseSse, translate } from './sse.mjs'
import { DeepSeekFileStore, DeepSeekUploadIndex } from './files.mjs'
import type { AdapterOptions, ConnectionOptions, PreparedImages, FileStoreBoundary } from './types.ts'
export { resolveOptions } from './config.ts'
export type { AdapterOptions, Config, ConnectionOptions, CatalogModel } from './types.ts'

function httpErrorCode(status: number, error: {code?:unknown;type?:unknown;message?:unknown} | undefined) {
  if (status === 401 || status === 403) return 'AUTH'
  if (status === 413) return 'INVALID_REQUEST'
  const detail = [error?.code,error?.type,error?.message].filter(row => typeof row === 'string').join(' ')
  if (isQuotaExceededError(detail)) return QUOTA_EXCEEDED_CODE
  if (status === 429) return 'RATE_LIMIT'
  if (status === 400) return isContextWindowExceededError(detail) ? CONTEXT_WINDOW_EXCEEDED_CODE : 'INVALID_REQUEST'
  return status >= 500 ? 'SERVER' : `HTTP_${status}`
}
export class ChatCompletionsCompatAdapter extends LlmAdapter {
  private readonly config: AdapterOptions
  private readonly files: FileStoreBoundary
  private readonly fetchImpl: typeof fetch
  constructor(config: AdapterOptions) {
    super()
    this.config = config
    this.fetchImpl = config.fetch ?? ((input, init) => globalThis.fetch(input, init))
    const initial = resolveOptions(config.options())
    this.files = config.files ?? new DeepSeekFileStore({fetch:this.fetchImpl,...initial.cachePath ? {index:new DeepSeekUploadIndex(initial.cachePath)} : {}})
  }
  providerInfo(provider: string) { return {id:provider,name:'Legacy DeepSeek ChatCompletions compatibility'} }
  providerRetryPolicy(_provider: string) { return resolveOptions(this.config.options()).retryPolicy }
  async listModels(provider: string) { return resolveOptions(this.config.options()).models.map(row => ({provider,id:row.id,name:row.name ?? row.id,...row.description ? {description:row.description} : {},inputModalities:row.inputModalities ?? ['text' as const]})) }
  private modelInfo(connection: ConnectionOptions, provider: string, model: string): LlmResolvedModelInfo {
    if (provider !== connection.provider) throw new LlmError('adapter does not own requested provider','NO_ADAPTER')
    const row = connection.models.find(entry => entry.id === model)
    const defaults = connection.defaults
    return {provider,id:model,name:row?.name ?? model,inputModalities:row?.inputModalities ?? ['text'],context:{contextWindow:row?.contextWindow ?? connection.defaultContextWindow},defaultMaxTokens:row?.maxTokens ?? connection.maxTokens,
      reasoning:{efforts:(defaults.thinking === 'disabled' ? ['off'] : ['off','low','high','max']).map(id => ({id:ReasoningEffortId(id),name:id})),defaultEffort:ReasoningEffortId(defaults.thinking === 'disabled' ? 'off' : defaults.reasoningEffort ?? 'high')}}
  }
  async resolveModel(provider: string, model: string, signal?: AbortSignal) { signal?.throwIfAborted(); return this.modelInfo(resolveOptions(this.config.options()),provider,model) }
  async prepareCall(provider: string, model: string, signal?: AbortSignal): Promise<PreparedAdapterCall> {
    signal?.throwIfAborted()
    const connection = resolveOptions(this.config.options())
    return {model:this.modelInfo(connection,provider,model),stream:options => this.streamWithConnection(options,connection)}
  }
  stream(options: GenerateOptions) { return this.streamWithConnection(options,resolveOptions(this.config.options())) }
  private async *streamWithConnection(options: GenerateOptions, connection: ConnectionOptions): AsyncIterable<StreamChunk> {
    if (options.provider !== connection.provider) throw new LlmError('adapter does not own requested provider','NO_ADAPTER')
    options.signal?.throwIfAborted()
    const consumer = new AbortController()
    const signal = options.signal ? AbortSignal.any([options.signal,consumer.signal]) : consumer.signal
    using watchdog = idleWatchdog(signal,connection.streamIdleTimeoutMs,'COMPAT_STREAM_IDLE_TIMEOUT')
    const iterator = this.request(options,connection,watchdog.signal,() => watchdog.pulse())[Symbol.asyncIterator]()
    let exhausted = false
    try {
      while (true) { const row = await watchdog.next(iterator); if (row.done) { exhausted = true; return }; yield row.value }
    } catch (error) {
      if (timeoutOf(watchdog.signal,'COMPAT_STREAM_IDLE_TIMEOUT') !== undefined) throw new LlmError('legacy ChatCompletions stream idle timeout','TIMEOUT',{cause:error})
      if (options.signal?.aborted) throw new LlmError('request aborted by caller','ABORTED',{cause:error})
      if (error instanceof LlmError) throw error
      throw new LlmError('legacy ChatCompletions transport failed','TRANSPORT',{cause:error})
    } finally {
      consumer.abort('consumer stopped')
      if (!exhausted && iterator.return) try { await iterator.return() } catch { /* cancelled transport teardown */ }
    }
  }
  private async *request(options: GenerateOptions, connection: ConnectionOptions, signal: AbortSignal, onActivity: () => void): AsyncIterable<StreamChunk> {
    const model = connection.models.find(row => row.id === options.model)
    const retainedImages = options.messages.flatMap(message => message.content.filter(block => block.type === 'image' && !block.offloaded))
    const versions = new Map<string,RequestImageAttachment>()
    if (retainedImages.length) {
      if (!model?.inputModalities?.includes('image')) throw new LlmError('model does not accept image input','UNSUPPORTED_CONTENT')
      const attachments = this.config.resolveAttachments?.()
      if (!attachments) throw new LlmError('image conversion requires attachment service','UNSUPPORTED_CONTENT')
      for (const block of retainedImages) {
        if (block.type !== 'image' || versions.has(block.attachment.attachmentId)) continue
        const ref = block.attachment
        const dimensions = requestImageDimensions(ref.width,ref.height,model.imagePixelBudget ?? (model.imageDetail === 'low' ? 512*512 : 640000))
        const version = await attachments.readImageRequest(ref,{...dimensions,maxBytes:model.imageMaxBytes ?? 1024*1024},signal)
        versions.set(ref.attachmentId,version)
        onActivity()
      }
    }
    const ensureBudget = (representation: 'file'|'base64') => {
      const count = requiredImageOffload(options.messages,{representation:representation === 'file' ? 'raw' : 'base64',maxBytes:representation === 'file' ? connection.maxRequestFilesBytes : connection.maxInlineRequestImageBytes,maxImages:connection.maxImagesPerRequest,byteQuantum:representation === 'file' ? connection.imageOffloadByteQuantum : connection.inlineImageOffloadByteQuantum,countQuantum:connection.imageOffloadCountQuantum},block => {
        const version = versions.get(block.attachment.attachmentId)
        if (!version) throw new LlmError('prepared image missing','INVALID_REQUEST')
        return version.bytes
      })
      if (count > 0) throw new LlmError('request images require durable offload',IMAGE_OFFLOAD_REQUIRED_CODE,{offloadImages:count})
    }
    if (versions.size) ensureBudget('file')
    const apiKey = assertUsableApiKey(await this.config.resolveApiKey(connection),'legacy ChatCompletions',connection.apiKeyEnv)
    signal.throwIfAborted()
    const userId = this.config.resolveUserId()
    const headers = {authorization:`Bearer ${apiKey}`,'content-type':'application/json',accept:'text/event-stream',...attributionHeaders(),'x-deepseek-harness-user-id':String(userId),...options.sessionId ? {'x-deepseek-harness-session-id':String(options.sessionId)} : {},...options.purpose === 'compaction' ? {'x-deepseek-harness-compact':'1'} : {}}
    const fileConnection = {baseURL:connection.baseURL,apiKey}
    let representation: 'file'|'base64' = 'file'
    let retry = 0
    while (true) {
      const fileIds = new Map<string,string>()
      if (versions.size && representation === 'file') {
        try {
          for (const version of versions.values()) {
            using timer = deadline(signal,connection.filesApiTimeoutMs,'COMPAT_FILES_TIMEOUT')
            const result = await this.files.ensureUploaded(version,fileConnection,{expiresAfterSeconds:connection.fileExpirySeconds,refreshMarginSeconds:connection.fileRefreshMarginSeconds,quotaCleanupBatch:0},timer.signal)
            fileIds.set(version.variantId,result.record.fileId); onActivity()
          }
        } catch (error) {
          if (signal.aborted) throw error
          representation = 'base64'; ensureBudget('base64')
        }
      }
      if (representation === 'base64' && versions.size) ensureBudget('base64')
      const images: PreparedImages | undefined = versions.size ? {versions,representation,fileIds} : undefined
      const body = serializeRequest(options,connection.defaults,images)
      const response = await this.fetchImpl(connection.baseURL + '/chat/completions',{method:'POST',headers,body:JSON.stringify(body),signal})
      onActivity()
      if (!response.ok) {
        let value: {error?:{code?:unknown;type?:unknown;message?:unknown}} | undefined
        try { value = await response.json() } catch { /* non-JSON provider diagnostic */ }
        const error = value?.error
        const detail = [error?.code,error?.type,error?.message].filter(row => typeof row === 'string').join(' ')
        if (fileIds.size && /file/iu.test(detail) && /expired|not[_ -]?found|deleted|invalid.{0,20}file/iu.test(detail) && retry++ === 0) {
          for (const version of versions.values()) { const id = fileIds.get(version.variantId); if (id) await this.files.invalidate(version,id,fileConnection) }
          continue
        }
        const retryAfter = response.headers.get('retry-after')
        const parsed = retryAfter === null ? NaN : Number(retryAfter)
        const delay = retryAfter === null ? undefined : Number.isFinite(parsed) && parsed >= 0 ? parsed*1000 : Math.max(0,Date.parse(retryAfter)-Date.now())
        const requestId = response.headers.get('x-request-id') ?? response.headers.get('request-id')
        throw new LlmError(typeof error?.message === 'string' ? error.message : `provider HTTP ${response.status}`,httpErrorCode(response.status,error),{status:response.status,...delay === undefined || !Number.isFinite(delay) ? {} : {providerRetryAfterMs:delay},...requestId ? {requestId:ProviderRequestId(requestId)} : {}})
      }
      if (!response.body) throw new LlmError('provider returned no response body','EMPTY_RESPONSE')
      yield* translate(parseSse(response.body,onActivity)); return
    }
  }
}
