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

## Configure OpenClaw

You can configure `r2-relay-channel` in two ways.

### Option 1: use the OpenClaw config wizard

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

After completing the wizard, restart the gateway:

```bash
openclaw gateway restart
```

### Option 2: edit OpenClaw config manually

Add a channel config entry for `r2-relay-channel` in your OpenClaw config.

Example:

```json5
{
  channels: {
    "r2-relay-channel": {
      enabled: true,
      endpoint: "https://<account>.r2.cloudflarestorage.com",
      bucket: "<bucket>",
      accessKeyId: "<access-key-id>",
      secretAccessKey: "<secret-access-key>",
      serverId: "gateway-home",
      pollIntervalMs: 5000,
      backoffMaxMs: 40000,
      defaultTtlDays: 7
    }
  },
  plugins: {
    entries: {
      "r2-relay-channel": {
        enabled: true
      }
    }
  }
}
```

After updating config, restart the gateway:

```bash
openclaw gateway restart
```

Once configured, use the same R2 connection details in ClawChat app.

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
