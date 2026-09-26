import type { FileStoreBoundary } from './types.ts'
export class DeepSeekUploadIndex { constructor(path?: string) }
export class DeepSeekFileStore implements FileStoreBoundary {
  constructor(options?: { index?: DeepSeekUploadIndex; now?: () => number; fetch?: typeof fetch })
  ensureUploaded: FileStoreBoundary['ensureUploaded']
  invalidate: FileStoreBoundary['invalidate']
}
