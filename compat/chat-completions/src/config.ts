import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { resolveRetryPolicy } from '@deepseek-ai/dsh-llm'
import type { Config, ConnectionOptions } from './types.ts'
export function resolveOptions(input: Config): ConnectionOptions {
  if (!input || typeof input.provider !== 'string' || !input.provider.trim()) throw new TypeError('explicit provider route required')
  const url = new URL(input.baseURL)
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new TypeError('baseURL must be an HTTP endpoint without credentials/query/fragment')
  credentialRef(input.apiKeyEnv)
  const config = structuredClone(input)
  const allowed = ['provider','baseURL','apiKeyEnv','models','defaults','maxTokens','defaultContextWindow','streamIdleTimeoutMs','filesApiTimeoutMs','maxRequestFilesBytes','maxInlineRequestImageBytes','maxImagesPerRequest','imageOffloadByteQuantum','inlineImageOffloadByteQuantum','imageOffloadCountQuantum','fileExpirySeconds','fileRefreshMarginSeconds','fileQuotaCleanupBatch','filePolicy','cachePath','retryPolicy']
  if (Object.keys(config).some(key => !allowed.includes(key))) throw new TypeError('unknown compatibility profile field')
  if (config.retryPolicy && 'initialDelayMs' in config.retryPolicy) {
    const allowed = config.retryPolicy.mode === 'normal' ? ['mode','initialDelayMs','maxDelayMs','jitterRatio','maxRetries','retryableCodes'] : ['mode','initialDelayMs','maxDelayMs','jitterRatio']
    if (Object.keys(config.retryPolicy).some(key => !allowed.includes(key))) throw new TypeError('unknown resolved retry policy field')
  }
  const defaults = config.defaults ?? {}
  if (!defaults || typeof defaults !== 'object' || Array.isArray(defaults) || Object.keys(defaults).some(key => !['thinking','reasoningEffort'].includes(key))) throw new TypeError('invalid defaults object')
  if (config.fileQuotaCleanupBatch !== undefined && config.fileQuotaCleanupBatch !== 0) throw new TypeError('remote quota cleanup is disabled')
  if (config.cachePath !== undefined && (typeof config.cachePath !== 'string' || !config.cachePath.length)) throw new TypeError('invalid cache path')
  if (config.filePolicy && Object.keys(config.filePolicy).some(key => !['expiresAfterSeconds','refreshMarginSeconds','quotaCleanupBatch'].includes(key))) throw new TypeError('unknown legacy file policy field')
  if (defaults.thinking !== undefined && !['enabled','disabled'].includes(defaults.thinking)) throw new TypeError('invalid thinking default')
  if (defaults.reasoningEffort !== undefined && !['off','low','high','max'].includes(defaults.reasoningEffort)) throw new TypeError('invalid reasoning effort')
  const positive = (value: number | undefined, fallback: number) => {
    const n = value ?? fallback
    if (!Number.isSafeInteger(n) || n <= 0) throw new TypeError('positive safe integer required')
    return n
  }
  const options: ConnectionOptions = {
    ...config, baseURL: config.baseURL.replace(/\/+$/u, ''), models: config.models ?? [], defaults,
    maxTokens: positive(config.maxTokens, 256000), defaultContextWindow: positive(config.defaultContextWindow, 1000000),
    streamIdleTimeoutMs: positive(config.streamIdleTimeoutMs, 300000), filesApiTimeoutMs: positive(config.filesApiTimeoutMs, 60000),
    maxRequestFilesBytes: positive(config.maxRequestFilesBytes, 128*1024*1024), maxInlineRequestImageBytes: positive(config.maxInlineRequestImageBytes, 20*1024*1024),
    maxImagesPerRequest: positive(config.maxImagesPerRequest, 600), imageOffloadByteQuantum: positive(config.imageOffloadByteQuantum, 64*1024*1024),
    inlineImageOffloadByteQuantum: positive(config.inlineImageOffloadByteQuantum, 10*1024*1024), imageOffloadCountQuantum: positive(config.imageOffloadCountQuantum, 20),
    fileExpirySeconds: positive(config.fileExpirySeconds, config.filePolicy?.expiresAfterSeconds ?? 604800), fileRefreshMarginSeconds: config.fileRefreshMarginSeconds ?? config.filePolicy?.refreshMarginSeconds ?? 3600,
    fileQuotaCleanupBatch: 0, retryPolicy: resolveRetryPolicy(config.retryPolicy === undefined ? undefined : 'initialDelayMs' in config.retryPolicy ? {mode:config.retryPolicy.mode,backoff:{initialDelayMs:config.retryPolicy.initialDelayMs,maxDelayMs:config.retryPolicy.maxDelayMs,jitterRatio:config.retryPolicy.jitterRatio},...config.retryPolicy.mode === 'normal' ? {maxRetries:config.retryPolicy.maxRetries,retryableCodes:[...config.retryPolicy.retryableCodes]} : {}} : config.retryPolicy, 'legacy chat-completions retryPolicy'),
  }
  if (options.streamIdleTimeoutMs > 2147483647 || options.filesApiTimeoutMs > 2147483647) throw new TypeError('timeout exceeds timer limit')
  if (options.fileExpirySeconds < 3600 || options.fileExpirySeconds > 2592000 || !Number.isSafeInteger(options.fileRefreshMarginSeconds) || options.fileRefreshMarginSeconds < 0 || options.fileRefreshMarginSeconds >= options.fileExpirySeconds) throw new TypeError('invalid file policy')
  const ids = new Set<string>()
  if (!Array.isArray(options.models)) throw new TypeError('models must be an array')
  for (const model of options.models) {
    if (!model || typeof model !== 'object' || Array.isArray(model) || typeof model.id !== 'string' || !model.id || ids.has(model.id)) throw new TypeError('model IDs must be nonempty strings and unique')
    if (Object.keys(model).some(key => !['id','name','description','contextWindow','maxTokens','inputModalities','imagePixelBudget','imageMaxBytes','imageDetail'].includes(key))) throw new TypeError('unknown model field')
    ids.add(model.id)
    for (const key of ['contextWindow','maxTokens','imagePixelBudget','imageMaxBytes'] as const) if (model[key] !== undefined) positive(model[key],1)
    if (model.inputModalities !== undefined && (!model.inputModalities.length || model.inputModalities.some(row => row !== 'text' && row !== 'image'))) throw new TypeError('invalid modalities')
    if (model.imageDetail !== undefined && !['auto','low'].includes(model.imageDetail)) throw new TypeError('invalid image detail')
  }
  return options
}
