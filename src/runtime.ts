import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import os from "node:os";
import { createPluginRuntimeStore } from "openclaw/plugin-sdk/runtime-store";
import type { PluginRuntime } from "openclaw/plugin-sdk/plugin-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk";
import { PLUGIN_ID } from "./config.js";

const { setRuntime: setRelayRuntime, getRuntime: getRelayRuntime } =
  createPluginRuntimeStore<PluginRuntime>("R2 Relay runtime not initialized");

let relayConfig: OpenClawConfig | null = null;
let relayStateDir: string | null = null;
let persistedServerId: string | null = null;

function setRelayConfig(cfg: OpenClawConfig) {
  relayConfig = cfg;
}

function getRelayConfig(): OpenClawConfig {
  if (!relayConfig) {
    throw new Error("R2 Relay config not initialized");
  }
  return relayConfig;
}

function setRelayStateDir(stateDir: string) {
  relayStateDir = stateDir;
}

function resolveFallbackStateDir(): string {
  const fromEnv = process.env.OPENCLAW_STATE_DIR?.trim();
  if (fromEnv) {
    return fromEnv;
  }
  return path.join(os.homedir(), ".openclaw");
}

function resolvePluginStateDir(): string {
  const baseStateDir = relayStateDir ?? resolveFallbackStateDir();
  return path.join(baseStateDir, "plugins", PLUGIN_ID);
}

function getPersistedRelayServerId(): string {
  if (persistedServerId) {
    return persistedServerId;
  }
  const dir = resolvePluginStateDir();
  const file = path.join(dir, "server-id.txt");
  try {
    const existing = fs.readFileSync(file, "utf8").trim();
    if (existing) {
      persistedServerId = existing;
      return existing;
    }
  } catch {}

  fs.mkdirSync(dir, { recursive: true });
  const generated = `srv-${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
  fs.writeFileSync(file, `${generated}\n`, "utf8");
  persistedServerId = generated;
  return generated;
}

export { getPersistedRelayServerId, getRelayConfig, getRelayRuntime, resolvePluginStateDir, setRelayConfig, setRelayRuntime, setRelayStateDir };
