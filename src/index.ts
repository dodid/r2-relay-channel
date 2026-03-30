import { defineChannelPluginEntry } from "openclaw/plugin-sdk/core";
import { r2RelayPlugin } from "./channel.js";
import { setRelayConfig, setRelayRuntime, setRelayStateDir } from "./runtime.js";

export default defineChannelPluginEntry({
  id: "r2-relay-channel",
  name: "R2 Relay",
  description: "Cloudflare R2 relay channel plugin for OpenClaw",
  plugin: r2RelayPlugin,
  setRuntime(runtime) {
    setRelayRuntime(runtime);
  },
  registerFull(api) {
    setRelayConfig(api.config);
    api.registerService({
      id: "r2-relay-channel-state",
      start(ctx) {
        setRelayStateDir(ctx.stateDir);
      },
    });
  },
});
