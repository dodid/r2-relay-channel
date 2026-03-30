import { z } from "zod";
import { DEFAULT_ACCOUNT_ID } from "openclaw/plugin-sdk/account-id";
import { buildChannelConfigSchema } from "openclaw/plugin-sdk/channel-config-schema";
import type { OpenClawConfig } from "openclaw/plugin-sdk";
import { getPersistedRelayServerId } from "./runtime.js";

export const DEFAULT_POLL_INTERVAL_MS = 5_000;
export const DEFAULT_BACKOFF_MAX_MS = 40_000;
export const DEFAULT_TTL_DAYS = 7;
export const DEFAULT_REGION = "auto";
export const DEFAULT_FORCE_PATH_STYLE = true;
export const CHANNEL_ID = "r2-relay-channel";
export const PLUGIN_ID = "r2-relay-channel";

export const R2RelayChannelConfigSchema = z.object({
  enabled: z.boolean().optional(),
  endpoint: z.string().url().min(1),
  bucket: z.string().min(1),
  accessKeyId: z.string().min(1),
  secretAccessKey: z.string().min(1),
  serverId: z.string().trim().min(1).optional(),
  pollIntervalMs: z.number().int().positive().optional(),
  backoffMaxMs: z.number().int().positive().optional(),
  defaultTtlDays: z.number().positive().optional(),
});

export const r2RelayChannelConfigSchema = buildChannelConfigSchema(R2RelayChannelConfigSchema);

export interface R2RelayAccountConfig {
  enabled?: boolean;
  endpoint?: string;
  bucket?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  serverId?: string;
  pollIntervalMs?: number;
  backoffMaxMs?: number;
  defaultTtlDays?: number;
}

export interface ResolvedR2RelayAccount {
  accountId: string;
  enabled: boolean;
  configured: boolean;
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

export function resolveR2RelayAccount(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): ResolvedR2RelayAccount {
  const relayCfg = getR2RelayConfig(params.cfg) ?? {};
  const endpoint = relayCfg.endpoint?.trim() ?? "";
  const bucket = relayCfg.bucket?.trim() ?? "";
  const accessKeyId = relayCfg.accessKeyId?.trim() ?? "";
  const secretAccessKey = relayCfg.secretAccessKey?.trim() ?? "";
  const configured = Boolean(endpoint && bucket && accessKeyId && secretAccessKey);

  return {
    accountId: DEFAULT_ACCOUNT_ID,
    enabled: relayCfg.enabled !== false,
    configured,
    endpoint,
    bucket,
    accessKeyId,
    secretAccessKey,
    serverId: normalizeServerId(relayCfg.serverId) ?? resolveDefaultServerId(params.cfg),
    region: DEFAULT_REGION,
    forcePathStyle: DEFAULT_FORCE_PATH_STYLE,
    pollIntervalMs: relayCfg.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
    backoffMaxMs: relayCfg.backoffMaxMs ?? DEFAULT_BACKOFF_MAX_MS,
    defaultTtlDays: relayCfg.defaultTtlDays ?? DEFAULT_TTL_DAYS,
    config: relayCfg,
  };
}
