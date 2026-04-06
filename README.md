# r2-relay-channel

`r2-relay-channel` is an OpenClaw channel plugin that uses Cloudflare R2 as a lightweight relay layer for chat delivery.

It is designed for setups where an OpenClaw server publishes session metadata and exchanges messages through an object-store-backed protocol instead of a conventional always-on websocket or direct mobile push transport.

## What it does

The plugin provides an R2-backed messaging channel for OpenClaw.

Core capabilities:
- publishes gateway identity and active session metadata
- appends messages into recipient-specific chains stored in R2
- reads inbox heads and walks message chains safely
- handles streaming-oriented message updates in the relay layer
- accepts authenticated cron webhook delivery and forwards summaries into a specific relay session
- packages cleanly as an OpenClaw plugin

## Why this exists

- **No ports open** — your server stays behind its firewall instead of being exposed directly to the internet.
- **Instant setup** — connect once without juggling bots, webhooks, or extra chat platform plumbing.
- **You own your data** — conversations live in your own Cloudflare R2 bucket, not on someone else's hosted chat service.
- **Chat your way** — the same OpenClaw backend can power a friendly mobile chat UI or a more terminal-style interface for power users.

## Requirements

- OpenClaw `2026.3.24` or later
- a Cloudflare R2 bucket
- an R2 endpoint URL
- an access key id and secret access key with bucket access

## Install the plugin in OpenClaw

Install the packaged tarball with OpenClaw:

```bash
openclaw plugins install /path/to/r2-relay-channel-x.y.z.tgz
```

If installation succeeds, restart the gateway:

```bash
openclaw gateway restart
```

You can inspect the installed plugin with:

```bash
openclaw plugins inspect r2-relay-channel
```

## Overwrite an installed plugin in place from a `.tgz`

If you want to unpack a built tarball directly over an existing installed plugin directory without deleting the directory itself, use:

```bash
./scripts/overwrite-installed-plugin.sh /path/to/r2-relay-channel-x.y.z.tgz /path/to/installed/plugin-dir
```

Example:

```bash
./scripts/overwrite-installed-plugin.sh ./r2-relay-channel-0.2.0.tgz ~/.openclaw/plugins/r2-relay-channel
```

This overwrites files that exist in the tarball but does not remove stale files already present in the destination directory.

## Configure OpenClaw

Use the OpenClaw config wizard.

After installing the plugin, run:

```bash
openclaw configure
```

or:

```bash
openclaw onboard
```

OpenClaw should expose `r2-relay-channel` as a channel setup flow and prompt for:
- R2 endpoint URL
- bucket name
- access key ID
- secret access key
- gateway server ID

The wizard suggests a short random server ID candidate automatically, and you can keep it or edit it. Keep it unique if you have multiple gateways sharing the same R2 bucket.

### What the wizard saves

The wizard writes the channel settings into the plugin-side config file:

```text
<plugin-folder>/r2relay.config.json
```

and keeps the main OpenClaw config minimal by only enabling the channel (and preserving a custom `configFile` path if you explicitly set one).

By default, the sidecar uses these retention settings:

```json
{
  "ttl": {
    "msg": 7,
    "att": 7,
    "identity": 1,
    "head": 30
  }
}
```

The plugin enforces retention with a daily sweeper:
- the gateway runs the sweeper in-process once per day after startup

After completing the wizard, restart the gateway:

```bash
openclaw gateway restart
```

Once configured, use the same R2 connection details in ClawChat app.

## `/session-target` command

The plugin registers a command that shows the current conversation's relay targets.

After at least one inbound relay message has established conversation state, run:

```text
/session-target
```

It returns two copy-pasteable code blocks:

- the cron target string
- the webhook URL or webhook path

## Native `--channel r2-relay-channel --to ...` delivery

The plugin supports native OpenClaw delivery targeting through `--channel r2-relay-channel` and a provider-specific `--to` format.

### Target format

Preferred deterministic target format:

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
- For backward compatibility, a bare target like `phone-abc123` is still accepted, but it sends without an explicit `sessionKey`.

## Cron webhook delivery to a specific relay session

The plugin exposes a minimal webhook endpoint for cron jobs.

Authentication uses OpenClaw's existing `cron.webhookToken`; there is no separate plugin token.

### Requirements

Set a cron webhook token in your OpenClaw config:

```json5
{
  cron: {
    webhookToken: "replace-with-a-random-secret"
  }
}
```

### Webhook path

```text
/r2-relay-channel/webhook/<peer>/<url-encoded-session-key>
```

Examples:

```text
/r2-relay-channel/webhook/phone-abc123/agent%3Amain%3Amain
```

### What the webhook accepts

The endpoint expects a JSON POST body. It accepts:

- cron finished-event payloads with a `summary` field
- simple manual payloads with a `text` field
- error payloads with an `error` field

It forwards the first non-empty value from `text`, `summary`, or `error` into the specified relay session.

### Cron example

```json
{
  "schedule": { "kind": "cron", "expr": "0 9 * * *" },
  "payload": {
    "kind": "agentTurn",
    "message": "Prepare the morning summary"
  },
  "delivery": {
    "mode": "webhook",
    "to": "https://example.com/r2-relay-channel/webhook/phone-abc123/agent%3Amain%3Amain"
  }
}
```

When cron runs this job, OpenClaw sends:

- `Authorization: Bearer <cron.webhookToken>`
- the cron finished event JSON body

and the plugin forwards the resulting summary text into the target relay session.

## Uninstall the plugin from OpenClaw

To remove the plugin:

1. remove or disable the `r2-relay-channel` entry from your OpenClaw config
2. uninstall the plugin
3. restart the gateway

Example uninstall command:

```bash
openclaw plugins uninstall r2-relay-channel
```

If `openclaw plugins uninstall r2-relay-channel` fails with an error like `unknown channel id: r2-relay-channel`, OpenClaw has already unloaded the plugin before validating the updated config.

In that case, use this manual recovery sequence:

1. edit your OpenClaw config and remove both:
   - `channels."r2-relay-channel"`
   - `plugins.entries."r2-relay-channel"`
2. save the config
3. remove the installed plugin directory if it still exists:

```bash
rm -rf ~/.openclaw/extensions/r2-relay-channel
```

4. restart the gateway:

```bash
openclaw gateway restart
```

Then restart:

```bash
openclaw gateway restart
```

## License

BSD 3-Clause License. See [LICENSE](LICENSE).
