# dsh-bluebubbles

把本地 [BlueBubbles](https://bluebubbles.app) 服务器（macOS 上的 iMessage 桥）接入 DeepSeek Harness 的插件。

## 能力

**REST 工具（模型按需调用）**

| 工具 | 作用 |
| --- | --- |
| `bluebubbles_configure` | 设置 baseUrl / 密码（自动 ping 验证） |
| `bluebubbles_ping` | 连通性与鉴权检查 |
| `bluebubbles_list_chats` | 列出 iMessage 会话 |
| `bluebubbles_get_messages` | 读取会话最近消息 |
| `bluebubbles_send_text` | 发送文本消息 |
| `bluebubbles_bind` | 绑定 chatGuid → DSH 工作区路径 |
| `bluebubbles_unbind` | 解除绑定 |
| `bluebubbles_list_bindings` | 查看绑定表 |
| `bluebubbles_webhook_status` | 查看/自注册 BlueBubbles webhook |

**推送（webhook）**

```
BlueBubbles 服务器（新消息）
   │  POST {type:"new-message", data:{...}}
   ▼
DSH webServer 路由  /bluebubbles/webhook  (loopback-only)
   │  查绑定表 chatGuid → workspacePath
   ▼
workspace.sessionIds[0] → agents.get(sessionId).send(userMessage, 'next-turn', true)
   ▼
该工作区的模型被唤醒，收到一条标注来源的用户消息
```

- 防回环：`isFromMe` 或 `tempGuid` 以 `dsh-` 开头的消息不回灌。
- 未绑定的会话：忽略并记日志。
- 绑定表持久化：`~/.dsh/bluebubbles-bindings.json`（写失败时降级为内存态）。

## 配置

| 环境变量 | 说明 |
| --- | --- |
| `BLUEBUBBLES_PASSWORD` | 服务器密码（优先）；DSH 进程启动早于变量写入时，回退读取 `~/.zshenv` |
| `BLUEBUBBLES_BASE_URL` | 服务器地址，默认 `http://localhost:1234` |
| `BLUEBUBBLES_BINDINGS` | 绑定表文件路径，默认 `~/.dsh/bluebubbles-bindings.json` |

仓库里不含任何密钥。

## 安全

- webhook 路由只接受 loopback 来源（`127.0.0.1` / `::1`）；BlueBubbles webhook 无签名机制。
- 注入内容只是文本消息，不会触发工具；发消息仍由模型显式调用 `bluebubbles_send_text`。
- 与 OpenClaw 等其它 BlueBubbles 消费者互不干扰（webhook 是服务端广播）。

## 平面归属与部署

- 目标平面：**host composition**。本插件发布 `bluebubbles` 服务、注册 HTTP 路由、跨会话注入 agent，是进程级共享能力；若放入 agent preset，`ctx.provide('bluebubbles')` 会触发 "published process-global service" mount 审计拒绝（第二会话挂载即撞名）。
- 加载方式：composition 行 `name: ./bluebubbles-dsh/src/index.js`（相对路径由 cordis-plugin-loader 直接解析，无需 npm 发布）。
- 本包为 **Host-only**；Client（设置页）留待后续以 `dsh.client` 双面包形式接入（需要 checkout 的 web 构建管线）。

## 与动态插件的关系

动态插件 `bubbl-1`（pkg-1/pkg-2，sandbox + harness API）是快速迭代载体；本仓库是持久化的真实插件移植版，稳定后作为 host composition 行挂载，重启不丢。

## 路线图

- [x] REST 工具 + 凭据引导（等价动态 pkg-2）
- [x] webhook 接收路由 + 绑定路由到工作区（初稿）
- [ ] host composition 行挂载 + mount 验证
- [ ] Client `dsh.client` 设置页（可选）
- [ ] 回环测试：真实 iMessage 消息进指定工作区
