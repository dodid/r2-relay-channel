import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { DEFAULT_ACCOUNT_ID } from "openclaw/plugin-sdk/account-id";
import { buildChannelConfigSchema } from "openclaw/plugin-sdk/channel-config-schema";
import type { OpenClawConfig } from "openclaw/plugin-sdk";
import { getPersistedRelayServerId } from "./runtime.js";

export const DEFAULT_POLL_INTERVAL_MS = 5_000;
export const DEFAULT_BACKOFF_MAX_MS = 40_000;
export const DEFAULT_TTL_DAYS = 7;
export const DEFAULT_IDENTITY_TTL_DAYS = 1;
export const DEFAULT_HEAD_TTL_DAYS = 30;
export const DEFAULT_REGION = "auto";
export const DEFAULT_FORCE_PATH_STYLE = true;
export const CHANNEL_ID = "r2-relay-channel";
export const PLUGIN_ID = "r2-relay-channel";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const R2RelaySidecarConfigSchema = z.object({
  enabled: z.boolean().optional(),
  endpoint: z.string().url().min(1),
  bucket: z.string().min(1),
  accessKeyId: z.string().min(1),
  secretAccessKey: z.string().min(1),
  serverId: z.string().trim().min(1).optional(),
  pollIntervalMs: z.number().int().positive().optional(),
  backoffMaxMs: z.number().int().positive().optional(),
  defaultTtlDays: z.number().positive().optional(),
  ttl: z.object({
    msg: z.number().positive().optional(),
    att: z.number().positive().optional(),
    identity: z.number().positive().optional(),
    head: z.number().positive().optional(),
  }).optional(),
});

export const R2RelayChannelConfigSchema = z.object({
  enabled: z.boolean().optional(),
  configFile: z.string().trim().min(1).optional(),
});

export const r2RelayChannelConfigSchema = buildChannelConfigSchema(R2RelayChannelConfigSchema);

export interface RelayTtlConfig {
  msg?: number;
  att?: number;
  identity?: number;
  head?: number;
}

export interface R2RelayAccountConfig {
  enabled?: boolean;
  configFile?: string;
  endpoint?: string;
  bucket?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  serverId?: string;
  pollIntervalMs?: number;
  backoffMaxMs?: number;
  defaultTtlDays?: number;
  ttl?: RelayTtlConfig;
}

export interface ResolvedR2RelayAccount {
  accountId: string;
  enabled: boolean;
  configured: boolean;
  configFile: string;
  endpoint: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  serverId: string;
  region: string;
  forcePathStyle: boolean;
  pollIntervalMs: number;
  backoffMaxMs: number;
  defaultTtlDays: number;
  ttl: Required<RelayTtlConfig>;
  config: R2RelayAccountConfig;
}

export function getR2RelayConfig(cfg: OpenClawConfig): R2RelayAccountConfig | undefined {
  return (cfg.channels as Record<string, unknown> | undefined)?.[CHANNEL_ID] as
    | R2RelayAccountConfig
    | undefined;
}

export function listR2RelayAccountIds(cfg: OpenClawConfig): string[] {
  const relayCfg = getR2RelayConfig(cfg);
  if (!relayCfg) {
    return [];
  }
  return [DEFAULT_ACCOUNT_ID];
}

export function resolveDefaultServerId(_cfg: OpenClawConfig): string {
  return getPersistedRelayServerId();
}

export function normalizeServerId(value?: string | null): string | null {
  const trimmed = value?.trim();
  if (!trimmed) {
    return null;
  }
  const normalized = trimmed.replace(/\s+/g, "-").replace(/[^a-zA-Z0-9._-]/g, "-");
  const collapsed = normalized.replace(/-+/g, "-").replace(/^[-_.]+|[-_.]+$/g, "");
  return collapsed || null;
}

export function resolveRelayConfigFilePath(configFile?: string | null): string {
  const trimmed = configFile?.trim();
  if (trimmed) {
    return path.resolve(trimmed);
  }
  return path.resolve(__dirname, "..", "r2relay.config.json");
}

export function loadR2RelaySidecarConfig(configFile: string): R2RelayAccountConfig {
  try {
    const raw = fs.readFileSync(configFile, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as R2RelayAccountConfig) : {};
  } catch {
    return {};
  }
}

export function resolveR2RelayAccount(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): ResolvedR2RelayAccount {
  const relayCfg = getR2RelayConfig(params.cfg) ?? {};
  const configFile = resolveRelayConfigFilePath(relayCfg.configFile);
  const rawFileCfg = loadR2RelaySidecarConfig(configFile);
  const parsedFileCfg = R2RelaySidecarConfigSchema.safeParse(rawFileCfg);
  const fileCfg: R2RelayAccountConfig = parsedFileCfg.success ? parsedFileCfg.data : {};
  const mergedCfg: R2RelayAccountConfig = {
    ...fileCfg,
    enabled: relayCfg.enabled ?? fileCfg.enabled,
    configFile,
  };
  const endpoint = mergedCfg.endpoint?.trim() ?? "";
  const bucket = mergedCfg.bucket?.trim() ?? "";
  const accessKeyId = mergedCfg.accessKeyId?.trim() ?? "";
  const secretAccessKey = mergedCfg.secretAccessKey?.trim() ?? "";
  const configured = Boolean(endpoint && bucket && accessKeyId && secretAccessKey);

  const ttl = {
    msg: mergedCfg.ttl?.msg ?? mergedCfg.defaultTtlDays ?? DEFAULT_TTL_DAYS,
    att: mergedCfg.ttl?.att ?? mergedCfg.defaultTtlDays ?? DEFAULT_TTL_DAYS,
    identity: mergedCfg.ttl?.identity ?? DEFAULT_IDENTITY_TTL_DAYS,
    head: mergedCfg.ttl?.head ?? DEFAULT_HEAD_TTL_DAYS,
  };

  return {
    accountId: DEFAULT_ACCOUNT_ID,
    enabled: mergedCfg.enabled !== false,
    configured,
    configFile,
    endpoint,
    bucket,
    accessKeyId,
    secretAccessKey,
    serverId: normalizeServerId(mergedCfg.serverId) ?? resolveDefaultServerId(params.cfg),
    region: DEFAULT_REGION,
    forcePathStyle: DEFAULT_FORCE_PATH_STYLE,
    pollIntervalMs: mergedCfg.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
    backoffMaxMs: mergedCfg.backoffMaxMs ?? DEFAULT_BACKOFF_MAX_MS,
    defaultTtlDays: mergedCfg.defaultTtlDays ?? DEFAULT_TTL_DAYS,
    ttl,
    config: mergedCfg,
  };
}
