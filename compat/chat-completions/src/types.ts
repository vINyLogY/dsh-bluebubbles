import type { AttachmentStore, RequestImageAttachment } from '@deepseek-ai/dsh-attachment'
import type { GenerateOptions, ModelModality, ResolvedRetryPolicy, RetryPolicyConfig } from '@deepseek-ai/dsh-llm'
export interface Defaults { thinking?: 'enabled' | 'disabled'; reasoningEffort?: 'off' | 'low' | 'high' | 'max' }
export interface CatalogModel {
  id: string; name?: string; description?: string; contextWindow?: number; maxTokens?: number
  inputModalities?: ModelModality[]; imagePixelBudget?: number; imageMaxBytes?: number; imageDetail?: 'auto' | 'low'
}
export interface Config {
  provider: string; baseURL: string; apiKeyEnv: string; models?: CatalogModel[]; defaults?: Defaults
  maxTokens?: number; defaultContextWindow?: number; streamIdleTimeoutMs?: number; filesApiTimeoutMs?: number
  maxRequestFilesBytes?: number; maxInlineRequestImageBytes?: number; maxImagesPerRequest?: number
  imageOffloadByteQuantum?: number; inlineImageOffloadByteQuantum?: number; imageOffloadCountQuantum?: number
  fileExpirySeconds?: number; fileRefreshMarginSeconds?: number; fileQuotaCleanupBatch?: 0
  /** Legacy resolved input bridge; quota cleanup is intentionally never run. */
  filePolicy?: {expiresAfterSeconds: number; refreshMarginSeconds: number; quotaCleanupBatch?: number}
  cachePath?: string; retryPolicy?: ResolvedRetryPolicy | RetryPolicyConfig
}
export interface ConnectionOptions extends Config {
  retryPolicy: ResolvedRetryPolicy
  models: CatalogModel[]; defaults: Defaults; maxTokens: number; defaultContextWindow: number
  streamIdleTimeoutMs: number; filesApiTimeoutMs: number; maxRequestFilesBytes: number
  maxInlineRequestImageBytes: number; maxImagesPerRequest: number; imageOffloadByteQuantum: number
  inlineImageOffloadByteQuantum: number; imageOffloadCountQuantum: number
  fileExpirySeconds: number; fileRefreshMarginSeconds: number; fileQuotaCleanupBatch: 0
}
export interface FileStoreBoundary {
  ensureUploaded(version: RequestImageAttachment, connection: {baseURL: string; apiKey: string}, policy: {expiresAfterSeconds: number; refreshMarginSeconds: number; quotaCleanupBatch: number}, signal?: AbortSignal): Promise<{record: {fileId: string}}>
  invalidate(version: RequestImageAttachment, fileId: string, connection: {baseURL: string; apiKey: string}): Promise<void>
}
export interface AdapterOptions {
  options: () => Config
  resolveApiKey: (connection: ConnectionOptions) => Promise<string>
  resolveUserId: () => string
  resolveAttachments?: () => Pick<AttachmentStore, 'readImageRequest'> | undefined
  fetch?: typeof fetch
  files?: FileStoreBoundary
}
export interface PreparedImages {
  versions: ReadonlyMap<string, RequestImageAttachment>
  representation: 'file' | 'base64'
  fileIds?: ReadonlyMap<string, string>
}
export type WireOptions = GenerateOptions
