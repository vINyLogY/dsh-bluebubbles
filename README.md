# dsh-bluebubbles

把本地 [BlueBubbles](https://bluebubbles.app) 服务器（macOS 上的 iMessage 桥）接入 DeepSeek Harness。

架构原则（Unix 哲学）：**host 插件只保留被动能力**（webhook 接收 + 绑定解析 + 消息注入）和**两个高频模型工具**（发文本/发附件）；其余一切操作收敛到 `bb-channel` CLI——agent 经 bash 调用，人和自动化脚本也能直接用。

## 组件

| 组件 | 位置 | 作用 |
| --- | --- | --- |
| `bluebubbles-bridge` | `src/index.ts` | webhook 路由 + 消息注入 + 2 个发送工具 + `bluebubbles` 服务 |
| `dsh-heartbeat` | `src/heartbeat.ts` | 通用定时唤醒（读 `heartbeat-targets.json`） |
| `dsh-cron` | `src/cron.ts` | cron 时刻任务（读 `cron-jobs.json`） |
| `bb-channel` | `bin/bb-channel.mjs` | CLI：chats/messages/send/bind/contacts/webhook/configure… |

## 模型工具（刻意只留两个）

| 工具 | 作用 |
| --- | --- |
| `bluebubbles_send_text` | 发送文本消息 |
| `bluebubbles_send_attachment` | 发送附件（图片/文件） |

其余操作全部走 CLI（agent 用 bash 调，等价能力）：

```bash
~/.local/bin/bb-channel chats [--limit N] [--all]      # 列会话（默认过滤占位/配对码噪音）
~/.local/bin/bb-channel messages <chatGuid> [--limit N] # 读历史（带发送者显示名）
~/.local/bin/bb-channel send <chatGuid> <文本...>       # 发文本
~/.local/bin/bb-channel send-attachment <chatGuid> <文件>
~/.local/bin/bb-channel attachment <guid> [--dir D]     # 下载附件
~/.local/bin/bb-channel bind <chatGuid> (--workspace PATH | --session ID)
~/.local/bin/bb-channel unbind <chatGuid>
~/.local/bin/bb-channel bindings                        # 查看绑定表
~/.local/bin/bb-channel contacts / set-contact <地址> <名字>
~/.local/bin/bb-channel webhook [--url URL]             # 查看/自注册 webhook
~/.local/bin/bb-channel ping / configure                # 连通性 / 写 ~/.dsh/.env
```

- 输出一律 pretty JSON（可 jq）；错误写 stderr 且 exit 1。
- 凭据链与插件相同：`process.env` → `~/.dsh/.env` → `~/.zshenv`，无需手填。
- CLI 直接编辑 `~/.dsh/bluebubbles-bindings.json` / `bluebubbles-contacts.json`；插件在每条入站消息前热重读这两个文件，**改完即生效，无需重载**。

## 推送链路（webhook）

```
BlueBubbles 服务器（新消息）
   │  POST {type:"new-message", data:{...}}
   ▼
DSH webServer 路由  /bluebubbles/webhook  (loopback-only)
   │  热重读绑定表/通讯录 → 查 chatGuid → workspacePath/sessionId
   ▼
workspace.sessionIds[0] → agents.get(sessionId).send(userMessage, 'next-step', true)
   ▼
该工作区的模型被唤醒，收到「📱 iMessage · 群名 · 来自 名字（号码）」标注的消息
```

**防回环（双层，v22+）**：

1. `pendingSent` 待发队列：插件每次发送前登记 `(chatGuid, 归一化文本)`，webhook 回显 `isFromMe=true` 的消息按此匹配丢弃（60s TTL，unicode NFC 归一比较）；
2. `seenGuids`：发送成功后把 API 返回的真实 guid 记入去重集（BlueBubbles 偶发重复推送同一事件，第二层兜底）。

不能再用 `isFromMe` 一刀切：同 Apple ID 的手机在**自聊 DM** 里发的消息也是 `isFromMe=true`，一刀切会误杀真实用户消息。

**发送者显示名**：`payload.handle.displayName` → `~/.dsh/bluebubbles-contacts.json`（地址→名字，`bb-channel set-contact` 维护）→ 裸号码。

## 配置

### 凭据

| 方式 | 生效时机 |
| --- | --- |
| `bb-channel configure --password <pw>`（写 `~/.dsh/.env`） | DSH 重启或桥重载后 |
| 环境变量 `BLUEBUBBLES_PASSWORD`（可加 `BLUEBUBBLES_BASE_URL`） | DSH 重启后 |

**`.env` 里严禁 `DSH_` 前缀变量**——DSH bootstrap 会拒绝启动。因此心跳/cron 的配置键是 `HEARTBEAT_INTERVAL` / `HEARTBEAT_TARGETS` / `CRON_JOBS`。

### 状态文件（`$DSH_HOME`，默认 `~/.dsh`）

| 路径 | 内容 | 写者 |
| --- | --- | --- |
| `bluebubbles-bindings.json` | `{ "chat:<guid>": { workspacePath \| sessionId } }` | `bb-channel bind/unbind` |
| `bluebubbles-contacts.json` | `{ "地址": "显示名" }` | `bb-channel set-contact` |
| `bluebubbles-media/` | 收到的附件统一存放处（`<guid>-<文件名>`） | bridge 自动下载 |
| `heartbeat-targets.json` | 心跳目标 | 手编 |
| `cron-jobs.json` | cron 任务 | 手编 |

**会话解析链**：`sessionId` 直连 → 否则 `workspacePath` → 该工作区 `sessionIds[0]`（最新会话）→ 校验活跃 agent。无活跃 agent 则丢弃并记日志（不回退、不排队）。

### 更新代码

1. 改 `src/*.ts` → `npm run typecheck` → `git commit`
2. 编辑 `~/.dsh/profiles/web/cordis.patch.yml` 对应行 `?v=N` +1 保存
3. 本进程 HMR 对桥模块的热替换不可靠（旧 fiber 路由残留），**重启 DSH 是可靠加载方式**；用 `curl -X POST -d '{}' http://127.0.0.1:3080/bluebubbles/webhook` 看版本标记（`ok-vN`）确认。

### 诊断

`BLUEBUBBLES_DEBUG=1`（env 或 `.env`）时，入站事件与丢弃原因写入 `~/.dsh/bluebubbles-debug.log`（串行化追加，不丢行）。

## 安全

- webhook 路由只接受 loopback 来源；BlueBubbles webhook 无签名机制。
- 注入内容只是文本消息，不触发工具；外发始终由模型显式调用发送工具。
- 仓库与 patch 文件不含密钥。

## 技术栈

- **TypeScript**（仅可擦除语法），类型来自 `@deepseek-ai/dsh-*` devDeps（0.1.0-rc.6 / cordis 4.0.1）。
- **零构建**：Node ≥ 23.6 原生类型剥离，composition 行直接指向 `src/index.ts`。
- CLI 为纯 Node ESM（`bin/bb-channel.mjs`），零依赖，全局 `fetch`/`FormData`。
- 初始化：`npm install --cache ./.npm-cache && npm run typecheck`。
