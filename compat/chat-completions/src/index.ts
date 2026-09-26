import type { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import { getOrCreateAnonymousUserId } from '@deepseek-ai/dsh-anonymous-user-id'
import { LlmError, assertUsableApiKey } from '@deepseek-ai/dsh-llm'
import { ChatCompletionsCompatAdapter } from './adapter.ts'
import { resolveOptions } from './config.ts'
import type { Config } from './types.ts'
export type { Config } from './types.ts'
export { ChatCompletionsCompatAdapter } from './adapter.ts'
export const name = 'legacy-011-deepseek-chat-completions-compat'
export const inject = ['llm']
export function apply(ctx: Context, config: Config) {
  // No inferred/default route and no automatic registration on module import.
  // Route identity is fixed for this entry lifetime; a reload is required to
  // change ownership. Connection/capability facts are snapshotted per operation.
  const initial = resolveOptions(config)
  const options = () => {
    const next = resolveOptions(config)
    if (next.provider !== initial.provider) throw new LlmError('provider ownership cannot change in place','INVALID_REQUEST')
    if (next.cachePath !== initial.cachePath) throw new LlmError('cachePath changes require plugin reload','INVALID_REQUEST')
    return next
  }
  const adapter = new ChatCompletionsCompatAdapter({
    options,
    resolveApiKey: async connection => {
      const ref = credentialRef(connection.apiKeyEnv)
      const stored = await ctx.get('credentials')?.resolve(ref)
      const value = stored?.value ?? launchEnvironmentOf(ctx).get(ref)?.value
      if (!value) throw new LlmError('credential reference is not configured','MISSING_CREDENTIAL')
      return assertUsableApiKey(value,name,ref)
    },
    resolveUserId: () => String(getOrCreateAnonymousUserId()),
    resolveAttachments: () => ctx.get('attachments'),
  })
  // SDK validation is atomic. A colliding owner is refused, never disposed or
  // replaced. Registration is scoped to this plugin fiber by the public SDK.
  ctx.llm.registerAdapter([initial.provider],adapter)
}
