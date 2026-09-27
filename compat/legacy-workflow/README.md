# Legacy DSH workflow compatibility candidate

Private, opt-in source port of the MIT-licensed DSH 0.1.1-rc.2 worker-thread
workflow DSL to **DSH 0.1.7-rc.2 only**. This is not the official package,
the stock PTC workflow engine, or an npm publication. Importing it does not
register a preset or change a provider/default. No history is rewritten.

An explicitly selected profile/preset may replace its missing legacy engine row
with this package's `src/index.mjs`. Preserve the existing row's config and its
composition's base URI; do not rename the preset, substitute a default, remove
tools, or discard policy rows. All host and worker SDK imports must physically
resolve to the **same complete target cohort** as the host, never an old SDK
tree nested under this package. Required public services are `subagents`,
`ptcRuntime`, and `sandboxPolicy`; the PTC provider must be the sandboxed Node
TypeScript **process** implementation. Missing dependencies fail closed.

The legacy host lifecycle/combinators and the inner Worker VM are preserved;
the execution structure is now a stock managed PTC process containing that
Worker. The VM exposes only the old `agent`, `parallel`, `pipeline`, `phase`,
`log`, and `args` globals. It is **not a malicious-code security boundary**.
The authoritative parent Session policy is resolved per execution and passed
to the public runner. Native confinement enforces authorized **file writes**;
it does not promise isolation from file reads or network access. Environment
scrubbing does not prevent secrets being read from accessible files.

Deliberate target restrictions:

- The actual PTC provider's finite default deadline and cap apply; this package
  never requests an unlimited deadline. Long asynchronous legacy workflows can
  now terminate at that deadline. Configure the public provider explicitly if
  another bounded deadline is needed.
- Both IPC directions share a cumulative 1 MiB / 10,000-frame budget, including
  phase/log events (which are not stock stdout). Optional `maxProtocolBytes`
  (1–64 MiB) and `maxProtocolEvents` (1–1,000,000) configure finite ceilings.
  Exceeding either stops execution and reaps owned children.
- Provider/model overrides use public `subagents.start`; providers lacking the
  target `agentOptions` capability are rejected, never silently ignored.
- Closed JSON frames, correlation ledgers, child total/concurrent caps, and
  duplicate child-call rejection are enforced by the host, not trusted to VM
  code. JSON serialization remains the legacy result boundary.
- Cancel/dispose terminates and awaits the managed process. Host provider start
  promises cannot be forcibly killed: bounded legacy disposal grace can return
  before an uncooperative start settles. A subsequently returned handle is
  disposed once and its result rejection consumed; it is never admitted.

Qualification must exercise the effective **last selected** preset, the global
selected default, and actual cold-resume IDs, not just session header presets.
Preset availability is not proof every tool/provider works. A narrow legacy
persona `text` → target `prefix` conversion additionally requires exact old
shape validation, empty `suffix`, and unchanged complete/runtime-context policy;
this package performs no such conversion automatically.

## Isolated checks

Run only in a disposable checkout with complete target dependencies beside its
real source. Set `DSH_LEGACY_NODE_MODULES` to a verified 0.1.1-rc.2 oracle cohort
and `DSH_WORKFLOW_CANARY_PARENT` to an explicitly authorized non-temp fixture
parent. The tests create/remove only uniquely named synthetic subdirectories
there; `/tmp` is not suitable for write-denial controls because the platform
policy permits temp writes. Native tests require actual sandbox support and
must not replace unavailable confinement with mocks.

```
node --test compat/legacy-workflow/test/*.test.mjs
```

Native workflow controls use synthetic sessions/providers only: no model calls,
messages or external network. Controlled-runtime transport tests are unit
proofs, not native enforcement proofs. The profile integration helper is a
separate explicitly parameterized private-copy qualification, not a live probe.
The legacy oracle runs the published old **guest** with a synthetic host JSON
protocol, not the complete old host engine: one-child requests/events/results
are compared exactly, while cancellation compares terminal scalars and cleanup.

Keep stock runtime/source/config/raw-history backups. Rollback restores the
prior profile definition and removes only this opt-in row; no raw/native session
data rollback or automatic resend is part of this package. Live activation
requires separate operator approval after immutable candidate review.
