import type { StreamChunk } from '@deepseek-ai/dsh-llm'
export function parseSse(stream: ReadableStream<Uint8Array>, onComment?: () => void): AsyncIterable<string>
export function translate(payloads: AsyncIterable<string>): AsyncIterable<StreamChunk>
