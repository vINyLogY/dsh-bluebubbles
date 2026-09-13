# dsh-bluebubbles

[![ci](https://github.com/vINyLogY/dsh-bluebubbles/actions/workflows/ci.yml/badge.svg)](https://github.com/vINyLogY/dsh-bluebubbles/actions/workflows/ci.yml)
[![dsh version verified by CI integration](https://img.shields.io/github/package-json/dependency-version/vINyLogY/dsh-bluebubbles/dev/@deepseek-ai/dsh?label=dsh%20%28ci-verified%29)](https://github.com/vINyLogY/dsh-bluebubbles/actions/workflows/ci.yml)

Bridges a local [BlueBubbles](https://bluebubbles.app) server (the macOS iMessage bridge) into DeepSeek Harness.

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
"📱 iMessage · <chat name> · 来自 <name> (<number>)"
```

**Anti-loop (two layers, v22+)**:

1. `pendingSent` queue: the plugin records `(chatGuid, normalized text)` before every send; webhook echoes with `isFromMe=true` matching an entry are dropped (60s TTL, unicode NFC-normalized comparison);
2. `seenGuids`: after a successful send the real guid returned by the API joins a dedup set (BlueBubbles occasionally pushes the same event twice — second-layer backstop).

A blanket `isFromMe` drop is not an option: phones on the same Apple ID also produce `isFromMe=true` in a **self-chat DM**, and dropping all of them would kill real user messages.

**Sender display name**: `payload.handle.displayName` → `~/.dsh/bluebubbles-contacts.json` (address→name, maintained via `bb-channel set-contact`) → bare number.

## Relay auto-delivery (same mode for inbound and cron)

With `relay: true` on a binding, the bridge registers a reply trigger for the woken session (persisted to `bluebubbles-relay-state.json`, 10min TTL, cleared on `turn/end`; an exact `NO_REPLY` reply suppresses delivery). During that turn, every assistant message containing text parts is sent back to the chat immediately — thinking and tool results are never delivered.

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

- **TypeScript** (erasable syntax only), types from `@deepseek-ai/dsh-*` devDeps (`^0.1.1-rc.2` / cordis `^4.0.1` — see the badge above for the exact CI-verified CLI version).
- **Zero build**: Node ≥ 23.6 native type stripping; composition rows point straight at `src/index.ts`.
- The CLI is plain Node ESM (`bin/bb-channel.mjs`), zero dependencies, global `fetch`/`FormData` — deliberately `.mjs` so it runs on any modern Node and stays ESM wherever it is symlinked.
- Bootstrap: `npm install --cache ./.npm-cache && npm run typecheck`.
