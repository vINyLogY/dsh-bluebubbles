# Legacy DeepSeek ChatCompletions compatibility

Private, optional profile plugin for **DSH 0.1.7-rc.2 only**, porting the MIT-licensed DSH 0.1.1-rc.2 DeepSeek request serializer, SSE translator and image-file cache. It is not a general OpenAI adapter, not published to npm, and not loaded by the BlueBubbles package. It does not rewrite sessions or fabricate Pi replay state.

Use an explicit absolute-path profile row pointing at `src/index.ts`, with an explicit configuration such as:

```yaml
- name: /absolute/path/compat/chat-completions/src/index.ts
  config:
    provider: synthetic-legacy-route
    baseURL: https://gateway.example.invalid/v1
    apiKeyEnv: SYNTHETIC_CREDENTIAL_REF
    models:
      - id: synthetic-model
        inputModalities: [text, image]
    defaults:
      thinking: enabled
      reasoningEffort: high
```

Keep the existing provider/model/endpoint and credential reference when preparing a real migration; do not substitute the synthetic example. Remove a competing adapter row explicitly before selecting the same route. The public SDK rejects duplicate registration atomically; this plugin never replaces another owner. Provider ownership and cache path require a plugin reload to change. Other configuration is captured per prepared call. Credentials resolve once at dispatch through the normal credential/launch-environment services, and the same value is used for Files requests and internal retries.

The entry's **physical source location** must resolve its imports to the same pinned 0.1.7-rc.2 dependency tree as the host. An absolute path or symlink to a checkout whose `node_modules` is legacy is not sufficient: Node resolves imports relative to the real source location. Verify resolved package paths and versions before enabling the row; the CI fixture asserts this boundary explicitly. The root package does not distribute or activate this checkout-local optional subpackage.

The protocol remains `/chat/completions` with Bearer authorization, separate `reasoning_content`, correlated tool calls/results and legacy thinking/effort fields. Native V4 system/tool/developer updates are projected through the public LLM SDK. Unknown catalog IDs remain advisory text-only routes; image input requires explicit model capabilities. This preserves a specific legacy protocol, not a guarantee that an arbitrary gateway accepts it.

Important boundaries:

- `[DONE]` without a finish reason retains legacy `stop`; EOF without `[DONE]` fails even after a finish reason. Usage precedes the terminal SDK chunk. Malformed SSE is an error, without echoing payload text in diagnostics.
- Requests are detached synchronously before lazy dispatch. Whole-request validation precedes attachment reads, credential resolution and remote writes; cancellation signals retain their identity.
- Image conversion uses the target attachment service and capability limits. Target durable placeholders/descriptors can differ from legacy display text. Oversized requests raise `IMAGE_OFFLOAD_REQUIRED` so the framework can persist offload markers; this plugin does not delete history.
- Unlike legacy quota recovery, this plugin never lists/deletes uploads merely because their filenames share a `dsh-` prefix. Files failures may fall back to bounded inline data or propagate. Only an upload created by the current request and losing an index race may be deleted by its exact ID. The local cache has a separate directory.

Tests use transport stubs, synthetic attachments and the exact legacy adapter as a wire oracle. Full-profile fixtures exercise checkpointed cold resume and separate replies without contacting model or messaging servers. See [NOTICE](NOTICE) for upstream attribution. Live deployment still requires a fresh quiesced backup, history migration gates and explicit operator approval.
