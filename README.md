# r2-relay-channel

- [English](#english)
- [简体中文](#simplified-chinese)

---

<a id="english"></a>

## English

`r2-relay-channel` is an OpenClaw channel plugin that uses Cloudflare R2 as a lightweight relay layer for chat delivery.

It is designed for setups where an OpenClaw server publishes session metadata and exchanges messages through an object-store-backed protocol instead of a conventional always-on websocket or direct mobile push transport.

### Why this exists

- **No ports open** — your server stays behind its firewall instead of being exposed directly to the internet.
- **Instant setup** — connect once without juggling bots, webhooks, or extra chat platform plumbing.
- **You own your data** — conversations live in your own Cloudflare R2 bucket, not on someone else's hosted chat service.
- **Chat your way** — the same OpenClaw backend can power a friendly mobile chat UI or a more terminal-style interface for power users.

### Security note

OpenClaw's plugin code-safety audit may warn that this plugin reads local files and sends data over the network. That warning is expected here: outbound media delivery intentionally reads agent-produced local files (for example images referenced by reply payloads) and uploads them to the configured Cloudflare R2 relay bucket so they can be delivered as attachments. Review this behavior in `src/channel.ts` (`buildRelayAttachments`) and use the plugin only in workspaces and relay buckets you trust.

### Requirements

- OpenClaw `2026.3.24` or later
- a Cloudflare R2 bucket
- an R2 endpoint URL
- an access key id and secret access key with bucket access

### Install the plugin in OpenClaw

Install directly from ClawHub by plugin id:

```bash
openclaw plugins install r2-relay-channel
openclaw gateway restart
```

### Configure OpenClaw

After installing the plugin, run:

```bash
openclaw configure
```

OpenClaw should expose `R2 Relay` as a channel setup flow and prompt for:

- R2 endpoint URL
- bucket name
- access key ID
- secret access key
- gateway server ID

The wizard suggests a short random server ID candidate automatically, and you can keep it or edit it. Keep it unique if you have multiple gateways sharing the same R2 bucket.

### Install ClawChat on iOS

To use this relay from iPhone or iPad, install ClawChat via TestFlight:

1. On your iOS device, open: https://testflight.apple.com/join/4941GHDE
2. Accept the TestFlight invitation.
3. Install ClawChat from TestFlight.
4. Open ClawChat and enter the same R2 connection details you configured for this plugin.

### `/session-target` command

The plugin registers a command that shows the current conversation's relay targets, which can be used for cron job delivery or direct webhook POSTing.

After at least one inbound relay message has established conversation state, run:

```text
/session-target
```

It returns two copy-pasteable code blocks:

- the cron target string
- the webhook URL

#### Cron target string

The plugin supports native OpenClaw delivery targeting through `--channel r2-relay-channel` and a provider-specific `--to` format.

The target format:

```text
peer=<peer>,session=<sessionKey>
```

Example:

```bash
openclaw cron add \
  --name "Morning brief" \
  --cron "0 7 * * *" \
  --tz "America/Los_Angeles" \
  --session isolated \
  --message "Summarize overnight updates." \
  --announce \
  --channel r2-relay-channel \
  --to 'peer=phone-abc123,session=agent:main:main'
```

Notes:

- `peer` is the relay recipient id.
- `session` is the exact OpenClaw session key to route into.
- `,` and `=` are reserved inside values in this minimal format.

#### Webhook URL

The plugin exposes a minimal webhook endpoint for cron jobs.

Authentication uses OpenClaw's existing `cron.webhookToken`; there is no separate plugin token.

Set a cron webhook token in your OpenClaw config:

```json5
{
  cron: {
    webhookToken: "replace-with-a-random-secret"
  }
}
```

The endpoint expects a JSON POST body. It accepts:

- cron finished-event payloads with a `summary` field
- simple manual payloads with a `text` field
- error payloads with an `error` field

It forwards the first non-empty value from `text`, `summary`, or `error` into the specified relay session.

Curl example:

```bash
curl -X POST 'http://127.0.0.1:18789/r2-relay-channel/webhook/moss-river-w5/agent%3Amain%3Amain' \
  -H 'Authorization: Bearer <cron.webhookToken>' \
  -H 'Content-Type: application/json' \
  --data '{"text":"hello from curl"}'
```

### Uninstall the plugin from OpenClaw

To remove the plugin:

```bash
openclaw plugins uninstall r2-relay-channel
openclaw gateway restart
```

---

<a id="simplified-chinese"></a>

## 简体中文

`r2-relay-channel` 是一个 OpenClaw 通道插件，使用 Cloudflare R2 作为轻量中继层来传递聊天消息。

它适用于这样的部署方式：OpenClaw 服务器负责发布会话元数据与消息交换，但底层通过对象存储协议完成中继，而不是依赖常驻 WebSocket 或直接移动推送。

### 这个插件为什么存在

- **无需开放端口**：你的服务器可以继续留在防火墙后，不必直接暴露到公网。
- **部署快速**：一次接入即可工作，无需再拼装 bot、webhook 或额外聊天平台链路。
- **数据归你所有**：会话数据存放在你自己的 Cloudflare R2 bucket，而不是第三方托管聊天服务。
- **聊天形态自由**：同一个 OpenClaw 后端既可驱动移动端友好 UI，也可支持偏终端风格的高阶交互。

### 依赖要求

- OpenClaw `2026.3.24` 或更高版本
- 一个 Cloudflare R2 bucket
- 一个 R2 endpoint URL
- 对该 bucket 有访问权限的 access key id 与 secret access key

### 在 OpenClaw 中安装插件

通过 ClawHub 使用插件 ID 直接安装：

```bash
openclaw plugins install r2-relay-channel
openclaw gateway restart
```

### 配置 OpenClaw

安装后执行：

```bash
openclaw configure
```

OpenClaw 应显示 `R2 Relay` 的通道配置流程，并提示你输入：

- R2 endpoint URL
- bucket name
- access key ID
- secret access key
- gateway server ID

向导会自动给出一个简短的随机 server ID 候选值。你可以直接使用，也可以修改。若多个 gateway 共享同一个 R2 bucket，请确保每个 server ID 唯一。

### 在 iOS 上安装 ClawChat

若要在 iPhone 或 iPad 上使用这个 relay，请通过 TestFlight 安装 ClawChat：

1. 在 iOS 设备上打开：https://testflight.apple.com/join/4941GHDE
2. 接受 TestFlight 邀请。
3. 在 TestFlight 中安装 ClawChat。
4. 打开 ClawChat，并填写与本插件一致的 R2 连接信息。

### `/session-target` 命令

插件会注册一个命令，用于显示当前会话可用的中继目标，可用于 cron 投递或直接 webhook POST。

至少先让一条入站中继消息建立会话状态，然后运行：

```text
/session-target
```

命令会返回两个可复制的代码块：

- cron target string
- webhook URL

#### Cron target string

插件支持 OpenClaw 原生投递目标：`--channel r2-relay-channel` 搭配 provider 专用 `--to` 格式。

目标格式：

```text
peer=<peer>,session=<sessionKey>
```

示例：

```bash
openclaw cron add \
  --name "Morning brief" \
  --cron "0 7 * * *" \
  --tz "America/Los_Angeles" \
  --session isolated \
  --message "Summarize overnight updates." \
  --announce \
  --channel r2-relay-channel \
  --to 'peer=phone-abc123,session=agent:main:main'
```

说明：

- `peer` 是中继接收端 id。
- `session` 是需要路由到的 OpenClaw 精确 session key。
- 该最小格式中，值内部保留字符为 `,` 与 `=`。

#### Webhook URL

插件提供一个简化 webhook 端点供 cron 调用。

认证沿用 OpenClaw 已有的 `cron.webhookToken`，无需单独插件 token。

请先在 OpenClaw 配置中设置 cron webhook token：

```json5
{
  cron: {
    webhookToken: "replace-with-a-random-secret"
  }
}
```

端点接收 JSON POST 请求，支持：

- 包含 `summary` 字段的 cron finished event 负载
- 包含 `text` 字段的手工请求负载
- 包含 `error` 字段的错误负载

插件会按 `text`、`summary`、`error` 的优先顺序选择第一个非空值，并转发到指定 relay session。

Curl 示例：

```bash
curl -X POST 'http://127.0.0.1:18789/r2-relay-channel/webhook/moss-river-w5/agent%3Amain%3Amain' \
  -H 'Authorization: Bearer <cron.webhookToken>' \
  -H 'Content-Type: application/json' \
  --data '{"text":"hello from curl"}'
```

### 从 OpenClaw 卸载插件

执行以下命令：

```bash
openclaw plugins uninstall r2-relay-channel
openclaw gateway restart
```

## License

MIT License. See [LICENSE](LICENSE).
