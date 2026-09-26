import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { resolveRetryPolicy } from '@deepseek-ai/dsh-llm'
import type { Config, ConnectionOptions } from './types.ts'
export function resolveOptions(input: Config): ConnectionOptions {
  if (!input || typeof input.provider !== 'string' || !input.provider.trim()) throw new TypeError('explicit provider route required')
  const url = new URL(input.baseURL)
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new TypeError('baseURL must be an HTTP endpoint without credentials/query/fragment')
  credentialRef(input.apiKeyEnv)
  const config = structuredClone(input)
  if (config.retryPolicy && 'initialDelayMs' in config.retryPolicy) {
    const allowed = config.retryPolicy.mode === 'normal' ? ['mode','initialDelayMs','maxDelayMs','jitterRatio','maxRetries','retryableCodes'] : ['mode','initialDelayMs','maxDelayMs','jitterRatio']
    if (Object.keys(config.retryPolicy).some(key => !allowed.includes(key))) throw new TypeError('unknown resolved retry policy field')
  }
  const defaults = config.defaults ?? {}
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
    fileExpirySeconds: positive(config.fileExpirySeconds, 604800), fileRefreshMarginSeconds: config.fileRefreshMarginSeconds ?? 3600,
    fileQuotaCleanupBatch: positive(config.fileQuotaCleanupBatch, 100), retryPolicy: resolveRetryPolicy(config.retryPolicy === undefined ? undefined : 'initialDelayMs' in config.retryPolicy ? {mode:config.retryPolicy.mode,backoff:{initialDelayMs:config.retryPolicy.initialDelayMs,maxDelayMs:config.retryPolicy.maxDelayMs,jitterRatio:config.retryPolicy.jitterRatio},...config.retryPolicy.mode === 'normal' ? {maxRetries:config.retryPolicy.maxRetries,retryableCodes:[...config.retryPolicy.retryableCodes]} : {}} : config.retryPolicy, 'legacy chat-completions retryPolicy'),
  }
  if (options.streamIdleTimeoutMs > 2147483647 || options.filesApiTimeoutMs > 2147483647) throw new TypeError('timeout exceeds timer limit')
  if (options.fileExpirySeconds < 3600 || options.fileExpirySeconds > 2592000 || !Number.isSafeInteger(options.fileRefreshMarginSeconds) || options.fileRefreshMarginSeconds < 0 || options.fileRefreshMarginSeconds >= options.fileExpirySeconds || options.fileQuotaCleanupBatch > 1000) throw new TypeError('invalid file policy')
  const ids = new Set<string>()
  for (const model of options.models) {
    if (!model.id || ids.has(model.id)) throw new TypeError('model IDs must be nonempty and unique')
    ids.add(model.id)
    for (const key of ['contextWindow','maxTokens','imagePixelBudget','imageMaxBytes'] as const) if (model[key] !== undefined) positive(model[key],1)
    if (model.inputModalities !== undefined && (!model.inputModalities.length || model.inputModalities.some(row => row !== 'text' && row !== 'image'))) throw new TypeError('invalid modalities')
    if (model.imageDetail !== undefined && !['auto','low'].includes(model.imageDetail)) throw new TypeError('invalid image detail')
  }
  return options
}
