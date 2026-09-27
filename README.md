# dsh-bluebubbles

[![ci](https://github.com/vINyLogY/dsh-bluebubbles/actions/workflows/ci.yml/badge.svg)](https://github.com/vINyLogY/dsh-bluebubbles/actions/workflows/ci.yml)
[![dsh version verified by CI integration](https://img.shields.io/github/package-json/dependency-version/vINyLogY/dsh-bluebubbles/dev/@deepseek-ai/dsh?label=dsh%20%28ci-verified%29)](https://github.com/vINyLogY/dsh-bluebubbles/actions/workflows/ci.yml)

Bridges a local [BlueBubbles](https://bluebubbles.app) server (the macOS iMessage bridge) into DeepSeek Harness.

> **DSH version support:** the supported host versions are `0.1.1-rc.1`,
> `0.1.1-rc.2`, and `0.1.7-rc.2`. CI tests locked legacy and next runtime
> cohorts with real session persistence, agents, shell execution, and two cold
> session-bound webhook routes. `0.1.5` and other untested prereleases are not
> supported. The optional, exact host peer declaration lets DSH check compatibility
> without installing another CLI into the plugin.

The bridge feature-detects the legacy/new shell and persistence APIs. Cold resume
keeps binding IDs and presets, restores a valid persisted model/token limit or
the configured default model, and preserves reasoning effort where supported.
Later web/UI model selections remain authoritative. The newer persistence backend
can migrate legacy session headers into a separate generation without changing
the original file; the legacy backend continues appending to its existing log.

Upgrading the host is a separate deployment step: back up the DSH home and pinned
runtime, install a complete locked runtime cohort, and verify the new profile and
preset registry configuration before switching it. These tests use synthetic
sessions and a loopback fake BlueBubbles server; they do not migrate live data or
send real iMessages. See [runtime test setup](test/runtime/README.md).

Design principle (Unix philosophy): **the host plugin keeps only passive capabilities** (webhook receive + binding resolution + message injection) and **two high-frequency model tools** (send text / send attachment); everything else converges into the `bb-channel` CLI — agents call it via bash, humans and automation scripts use it directly.

## Components

| Component | Location | Role |
| --- | --- | --- |
| `bluebubbles-bridge` | `src/index.ts` | webhook route + message injection + 2 send tools + the `bluebubbles` service |
| `dsh-heartbeat` | `src/heartbeat.ts` | generic periodic wake-up (reads `heartbeat-targets.json`) |
| `dsh-cron` | `src/cron.ts` | cron-time tasks (reads `cron-jobs.json`) |
| `bb-channel` | `bin/bb-channel.mjs` | CLI: chats/messages/send/bind/contacts/webhook/configure… |

## Model tools (deliberately only two)

| Tool | Role |
| --- | --- |
| `bluebubbles_send_text` | send a text message |
| `bluebubbles_send_attachment` | send an attachment (image/file) |

Everything else goes through the CLI (agents call it via bash — equivalent capability):

```bash
~/.local/bin/bb-channel chats [--limit N] [--all]      # list chats (placeholder/pairing-code noise hidden by default)
~/.local/bin/bb-channel messages <chatGuid> [--limit N] # read history (with sender display names)
~/.local/bin/bb-channel send <chatGuid> <text...>       # send text
~/.local/bin/bb-channel send-attachment <chatGuid> <file>
~/.local/bin/bb-channel attachment <guid> [--dir D]     # download an attachment
~/.local/bin/bb-channel bind <chatGuid> (--workspace PATH | --session ID)
~/.local/bin/bb-channel unbind <chatGuid>
~/.local/bin/bb-channel bindings                        # show the binding table
~/.local/bin/bb-channel contacts / set-contact <address> <name>
~/.local/bin/bb-channel webhook [--url URL]             # check/self-register the webhook
~/.local/bin/bb-channel ping / configure                # connectivity / write ~/.dsh/.env
```

- Output is always pretty JSON (jq-friendly); errors go to stderr with exit 1.
- Credential chain matches the plugin: `process.env` → `~/.dsh/.env` → `~/.zshenv`; nothing to fill in by hand.
- The CLI edits `~/.dsh/bluebubbles-bindings.json` / `bluebubbles-contacts.json` directly; the plugin hot re-reads both files before every inbound message — **edits take effect immediately, no reload**.

## Push path (webhook)

```
BlueBubbles server (new message)
   │  POST {type:"new-message", data:{...}}
   ▼
DSH webServer route  /bluebubbles/webhook  (loopback only)
   │  hot re-read bindings/contacts → look up chatGuid → workspacePath/sessionId
   ▼
workspace.sessionIds[0] → agents.get(sessionId).send(userMessage, 'next-step', true)
   ▼
The workspace's model wakes up and sees a message annotated
"📱 iMessage · <MM-DD HH:mm UTC±N> · <chat name> · 来自 <name> (<number>)"
```

The header stamp comes from the message's `dateCreated` (BlueBubbles hands back either Apple epoch ms
or Unix ms — disambiguated by magnitude), rendered in the host timezone and always suffixed with the
UTC offset. `BLUEBUBBLES_TZ` overrides the zone (e.g. `BLUEBUBBLES_TZ=Asia/Shanghai`); the year is
prepended only when the message isn't from the current year. An unknown/unsupported `BLUEBUBBLES_TZ`
falls back to the host zone, and if `Intl` rejects the zone at format time the stamp degrades to a
plain host-local stamp — the header is decoration and never breaks inbound delivery. Messages
without `dateCreated` keep the old header unchanged.

**Anti-loop (two layers, v22+)**:

1. `pendingSent` queue: the plugin records `(chatGuid, normalized text)` before every send; webhook echoes with `isFromMe=true` matching an entry are dropped (60s TTL, unicode NFC-normalized comparison);
2. `seenGuids`: after a successful send the real guid returned by the API joins a dedup set (BlueBubbles occasionally pushes the same event twice — second-layer backstop).

A blanket `isFromMe` drop is not an option: phones on the same Apple ID also produce `isFromMe=true` in a **self-chat DM**, and dropping all of them would kill real user messages.

**Sender display name**: `payload.handle.displayName` → `~/.dsh/bluebubbles-contacts.json` (address→name, maintained via `bb-channel set-contact`) → bare number.

**Quoted replies (swipe-reply)**: iMessage stamps `replyToGuid` on essentially every message, and its default parent is just the previous message of the chat — the pointer alone therefore cannot tell a real quote from that chain (measured: 35 of 40 consecutive messages carried a `replyToGuid` and all 35 pointed at their predecessor). The bridge remembers the last message guid per chat and renders a quote **only when the parent is something else**, by reading that message back from BlueBubbles:

```
↪ 引用（<author>）：「<parent text, whitespace collapsed, 40 chars + …>」
```

The author is `我` for a message the relayed account itself sent; otherwise it resolves through the same chain the header uses (`payload.handle.displayName` → contacts → bare address), with `对方` as the last resort. A self-chat DM typed on another Mac that shares the Apple ID also arrives as `isFromMe`, and that label cannot tell those apart. Tapbacks are excluded — BlueBubbles already renders them as `很疑惑：<quoted text>`, so quoting again would double it. The parent lookup explicitly requests attachments: a parent without text renders `（附件）` when it has attachments. A failed lookup, including a shell infrastructure exception, drops only the quote line; the incoming message itself is still delivered.

The per-chat memory lives in process, so the first inbound message after a plugin reload never quotes. The first webhook observation of a bridge-send echo advances memory before its anti-loop drop, even if the REST send already registered its guid for delivery dedup. Repeated observations do not advance it; this separate observation cache retains the latest 500 unique guids. A message whose creation timestamp is older than the latest remembered timestamp is delivered without a quote and does not rewind memory, since its actual predecessor is unknown. When timestamps are absent or equal, new observations use arrival order. This remains a heuristic: missed webhooks or ambiguous ordering can prevent accurate quote detection.

## Relay auto-delivery (same mode for inbound and cron)

With `relay: true` on a binding, the bridge registers a reply trigger for the woken session (persisted to `bluebubbles-relay-state.json`). Idle triggers expire after ten minutes at the next `turn/start`, and stale persisted triggers are ignored at startup. Once a turn starts, replies remain deliverable even when the task takes longer than ten minutes. Every `turn/end`, including an error, clears the trigger; retrying needs a fresh inbound message or explicit `armRelay` call. An exact `NO_REPLY` reply also clears it. During that turn, every assistant message containing text parts is sent back to the chat immediately — thinking and tool results are never delivered.

After a DSH restart, a bound session resumes with the provider/model from its latest valid `request/header`, including a valid output-token limit when present. Header-only sessions use the deployment default model. If neither supplies a complete model selection, the bridge logs the failure and skips delivery rather than creating an unusable agent.

When `dsh-cron` fires a job whose target session has a `relay: true` binding, it arms the same mechanism through the `bluebubbles` service's `armRelay`. **Cron task prompts must not tell the model to call send tools itself** — that would double-send.

## Headless guard (no web UI attached)

A session driven purely over iMessage has nobody to click the web UI's interactive cards, and both cards would otherwise park the turn forever. For any session named by the bindings table (including subagent children of one), the bridge registers prepend listeners that run ahead of the web answerers:

- **`ask_user_question` is denied** with a corrective message telling the model to ask in plain text instead — the reply is relayed to iMessage automatically, then the turn ends and the user's next iMessage answers it;
- **approval requests are auto-decided** — default `reject` (fail closed: sandbox escalations are denied and the model is told to continue without them). Set `BLUEBUBBLES_GUARD_APPROVAL=allow` to auto-approve instead, only for trusted setups.

Sessions not in the bindings table fall through to the ordinary web flow unchanged. Disable the guard entirely with `BLUEBUBBLES_GUARD=0`.

## Configuration

### Credentials

| Method | Takes effect |
| --- | --- |
| `bb-channel configure --password <pw>` (writes `~/.dsh/.env`) | after DSH restart or bridge reload |
| env var `BLUEBUBBLES_PASSWORD` (optionally `BLUEBUBBLES_BASE_URL`) | after DSH restart |

**Never put `DSH_`-prefixed variables in `.env`** — the DSH bootstrap refuses to start. That is why heartbeat/cron config keys are `HEARTBEAT_INTERVAL` / `HEARTBEAT_TARGETS` / `CRON_JOBS`.

### State files (`$DSH_HOME`, default `~/.dsh`)

| Path | Content | Writer |
| --- | --- | --- |
| `bluebubbles-bindings.json` | `{ "chat:<guid>": { workspacePath \| sessionId } }` | `bb-channel bind/unbind` |
| `bluebubbles-contacts.json` | `{ "address": "display name" }` | `bb-channel set-contact` |
| `bluebubbles-media/` | inbound attachments (`<guid>-<filename>`) | bridge auto-download |
| `heartbeat-targets.json` | heartbeat targets | hand-edited |
| `cron-jobs.json` | cron jobs | hand-edited |

**Session resolution chain**: `sessionId` direct → otherwise `workspacePath` → that workspace's `sessionIds[0]` (most recent session) → live agent. With no live agent, the bridge **resumes the persisted session on demand** (folding its stored preset, same as the web UI's attach path) — bound chats survive DSH restarts without anyone reopening them. A message is dropped and logged only when the resume itself fails (unknown session, subagent-owned session, missing preset).

## Optional WebUI binding settings (DSH `0.1.7-rc.2` only)

The optional page adds **Settings → iMessage** without changing the official
WebUI. It lists existing chat summaries, sessions, and bindings; select a chat
and an exact session, save/unbind, or toggle automatic reply delivery (`relay`).
It does not create chats, send test messages, activate a model, or change presets.
Session availability is a listing hint; saving validates the session's current
effective preset (including later persisted selections), without resuming it.

After installing/enabling the bridge in a `0.1.7-rc.2` Web profile, explicitly
install the optional local package from the same release checkout:

```sh
dsh plugin --profile web add ./client/bindings-ui
```

Its opt-in bundle adds `dsh-bluebubbles/bindings-management` and the browser
settings entry. The profile must already provide the official authenticated
Connection/API Gateway and settings/client-module services. Reload the profile
through your normal deployment process; this is not enabled by installing the
legacy bridge alone. The committed `lib/client.js` asset works from a Git release
without a local frontend build. Development builds use the client package's
locked `npm ci && npm run build`; CI checks the committed bundle is reproducible.

Management uses the existing browser authentication and Host/Origin fences,
not anonymous webhook CRUD. Passwords, endpoint configuration, and message
bodies are not returned by the binding API. One canonical
`bluebubbles-bindings.json` remains shared with `bb-channel`; unknown fields and
old workspace/legacy records are preserved. Existing dangling/conflicting
bindings are shown, not silently repaired. New bindings are exact-session and
reject another chat's resolved session, including workspace aliases. Changing
relay on a workspace binding does not convert it into an exact-session binding.

Saves use a byte-hash revision, a cooperative file lock, and fsynced temporary
files published by atomic rename. The CLI from this release uses the same lock
protocol; conflicts require refreshing rather than automatic retry. Older CLI
binaries and arbitrary editors that ignore the lock are not guaranteed
compare-and-swap writers: observed
external edits are refused, but the final compare/rename window cannot protect
against an editor ignoring the protocol. A leftover `.lock` after a process kill
is fail-closed; inspect it and ensure its writer has stopped before manual removal.
Power-loss/process-kill durability has not been qualified by these tests.

While inbound admission, a reply trigger/send, or an affected agent is active,
management refuses changes as busy. The check and publication share an admission
boundary; live idle agents reserve public maintenance ownership during the save.
Before an inbound reply is sent, the bridge rechecks the canonical chat/session/
relay association under the file lease, so a CLI unbind/rebind cannot deliver a
late reply using a stale binding. Explicit tool sends and scheduler `armRelay`
retain their separate authorization semantics. If a browser timeout occurs,
the write outcome is **unknown**: refresh first; do not assume it failed or retry
the mutation automatically. Failed saves never report success or pre-update the
bridge's active map. CLI updates still hot-apply on the next inbound message.

## Updating the code

1. Edit `src/*.ts` → `npm run typecheck` → `git commit`
2. In `~/.dsh/profiles/web/cordis.patch.yml`, bump the corresponding row's `?v=N` by 1 and save
3. In-process HMR does not reliably hot-replace the bridge module (stale fiber routes survive), so **restarting DSH is the reliable load path**; verify the version marker with `curl -X POST -d '{}' http://127.0.0.1:3080/bluebubbles/webhook` (`ok-vN`).

### Diagnostics

With `BLUEBUBBLES_DEBUG=1` (env or `.env`), inbound events and drop reasons go to `~/.dsh/bluebubbles-debug.log` (serialized appends, no lost lines).

## Security

- The webhook route only accepts loopback sources; BlueBubbles webhooks have no signing mechanism.
- Injected content is plain text messages and triggers no tools; outbound sends always happen through explicit model tool calls.
- Neither the repository nor the patch file contains credentials.

## Installation

As a profile bundle (consumers):

```bash
dsh plugin --profile web add github:vINyLogY/dsh-bluebubbles
```

`dsh plugin add` forwards to pnpm and, because this package declares
`dsh.bundle.patch`, automatically joins the profile's bundle stack — the
shipped `cordis.patch.yml` inserts rows for all three plugins
(`bluebubbles-bridge`, `dsh-heartbeat`, `dsh-cron`, resolved through the
package exports map). A DSH restart loads them. The `bb-channel` CLI lands on
the profile's `node_modules/.bin` via the package `bin` entry.

For local development, insert absolute-path rows with a `?v=N` cache-buster
into the profile's own `cordis.patch.yml` instead (see below).

## Tech stack

The optional [legacy ChatCompletions compatibility plugin](compat/chat-completions/README.md) is a separate, explicitly configured DSH 0.1.7-rc.2-only provider; installing this bridge does not activate it. Inbound producer attribution uses the real session header: format 0 retains the legacy wrapper and format 4 uses its official producer-owned spelling. Missing or other formats refuse delivery rather than guessing a future schema.

- **TypeScript** (erasable syntax only), types from `@deepseek-ai/dsh-*` devDeps (`^0.1.1-rc.2` / cordis `^4.0.1` — see the badge above for the exact CI-verified CLI version). The `0.1.5-rc.x` line is untested and currently unsupported.
- **Zero build**: Node ≥ 23.6 native type stripping; composition rows point straight at `src/index.ts`.
- The CLI is plain Node ESM (`bin/bb-channel.mjs`), zero dependencies, global `fetch`/`FormData` — deliberately `.mjs` so it runs on any modern Node and stays ESM wherever it is symlinked.
- Bootstrap: `npm install --cache ./.npm-cache && npm run typecheck`.
