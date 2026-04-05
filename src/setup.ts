import fs from "node:fs";
import path from "node:path";
import { DEFAULT_ACCOUNT_ID } from "openclaw/plugin-sdk/account-id";
import type { OpenClawConfig } from "openclaw/plugin-sdk/core";
import type { ChannelSetupAdapter, ChannelSetupInput, ChannelSetupWizard } from "openclaw/plugin-sdk/setup";
import {
  CHANNEL_ID,
  DEFAULT_BACKOFF_MAX_MS,
  DEFAULT_FORCE_PATH_STYLE,
  DEFAULT_HEAD_TTL_DAYS,
  DEFAULT_IDENTITY_TTL_DAYS,
  DEFAULT_POLL_INTERVAL_MS,
  DEFAULT_REGION,
  DEFAULT_TTL_DAYS,
  loadR2RelaySidecarConfig,
  normalizeServerId,
  resolveRelayConfigFilePath,
} from "./config.js";

type ChannelSection = {
  enabled?: boolean;
  configFile?: string;
};

type SidecarSection = {
  enabled?: boolean;
  endpoint?: string;
  bucket?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  serverId?: string;
  region?: string;
  forcePathStyle?: boolean;
  pollIntervalMs?: number;
  backoffMaxMs?: number;
  defaultTtlDays?: number;
  ttl?: {
    msg?: number;
    att?: number;
    identity?: number;
    head?: number;
  };
};

function getChannelSection(cfg: OpenClawConfig): ChannelSection {
  return ((cfg.channels as Record<string, unknown> | undefined)?.[CHANNEL_ID] as ChannelSection | undefined) ?? {};
}

function withChannelSection(cfg: OpenClawConfig, patch: Partial<ChannelSection>): OpenClawConfig {
  const currentChannels = (cfg.channels as Record<string, unknown> | undefined) ?? {};
  const nextSection: ChannelSection = {
    enabled: true,
    ...getChannelSection(cfg),
    ...patch,
  };

  return {
    ...cfg,
    channels: {
      ...currentChannels,
      [CHANNEL_ID]: nextSection,
    },
    plugins: {
      ...(cfg.plugins ?? {}),
      entries: {
        ...((cfg.plugins?.entries as Record<string, unknown> | undefined) ?? {}),
        [CHANNEL_ID]: {
          enabled: true,
        },
      },
    },
  };
}

function currentString(cfg: OpenClawConfig, key: keyof SidecarSection): string | undefined {
  const sidecar = getSidecarSection(cfg);
  const value = sidecar[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

function normalizeEndpoint(value: string): string {
  return value.trim().replace(/\/+$/, "");
}

function validateUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return "Use an http:// or https:// endpoint URL.";
    }
    return undefined;
  } catch {
    return "Enter a valid endpoint URL.";
  }
}

function randomServerIdCandidate(): string {
  const nouns = ["otter", "harbor", "pine", "comet", "rook", "fern"];
  const noun = nouns[Math.floor(Math.random() * nouns.length)];
  const suffix = Math.floor(Math.random() * 900 + 100);
  return `gw-${noun}-${suffix}`;
}

function suggestedServerId(cfg: OpenClawConfig): string {
  return currentString(cfg, "serverId") ?? randomServerIdCandidate();
}

function getConfiguredConfigFileValue(cfg: OpenClawConfig): string | undefined {
  const configured = getChannelSection(cfg).configFile?.trim();
  return configured || undefined;
}

function getConfigFilePath(cfg: OpenClawConfig): string {
  return resolveRelayConfigFilePath(getConfiguredConfigFileValue(cfg));
}

function getSidecarSection(cfg: OpenClawConfig): SidecarSection {
  return loadR2RelaySidecarConfig(getConfigFilePath(cfg));
}

function configPointerPatch(cfg: OpenClawConfig): Partial<ChannelSection> {
  const configured = getConfiguredConfigFileValue(cfg);
  return configured ? { enabled: true, configFile: configured } : { enabled: true, configFile: getConfigFilePath(cfg) };
}

function buildExpandedSidecarSection(cfg: OpenClawConfig, patch: Partial<SidecarSection>): SidecarSection {
  const current = getSidecarSection(cfg);
  const merged: SidecarSection = {
    ...current,
    ...patch,
  };

  const defaultTtlDays = merged.defaultTtlDays ?? DEFAULT_TTL_DAYS;

  return {
    enabled: merged.enabled ?? true,
    endpoint: merged.endpoint,
    bucket: merged.bucket,
    accessKeyId: merged.accessKeyId,
    secretAccessKey: merged.secretAccessKey,
    serverId: merged.serverId,
    region: merged.region ?? DEFAULT_REGION,
    forcePathStyle: merged.forcePathStyle ?? DEFAULT_FORCE_PATH_STYLE,
    pollIntervalMs: merged.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
    backoffMaxMs: merged.backoffMaxMs ?? DEFAULT_BACKOFF_MAX_MS,
    defaultTtlDays,
    ttl: {
      msg: merged.ttl?.msg ?? defaultTtlDays,
      att: merged.ttl?.att ?? defaultTtlDays,
      identity: merged.ttl?.identity ?? DEFAULT_IDENTITY_TTL_DAYS,
      head: merged.ttl?.head ?? DEFAULT_HEAD_TTL_DAYS,
    },
  };
}

function writeSidecarSection(cfg: OpenClawConfig, patch: Partial<SidecarSection>): void {
  const filePath = getConfigFilePath(cfg);
  const next = buildExpandedSidecarSection(cfg, patch);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
}

function applyInputToConfig(cfg: OpenClawConfig, input: ChannelSetupInput): OpenClawConfig {
  const patch: Partial<SidecarSection> = {
    enabled: true,
    region: DEFAULT_REGION,
    forcePathStyle: DEFAULT_FORCE_PATH_STYLE,
    pollIntervalMs: DEFAULT_POLL_INTERVAL_MS,
    backoffMaxMs: DEFAULT_BACKOFF_MAX_MS,
    defaultTtlDays: DEFAULT_TTL_DAYS,
    ttl: {
      msg: DEFAULT_TTL_DAYS,
      att: DEFAULT_TTL_DAYS,
      identity: DEFAULT_IDENTITY_TTL_DAYS,
      head: DEFAULT_HEAD_TTL_DAYS,
    },
  };

  if (typeof input.url === "string" && input.url.trim()) {
    patch.endpoint = normalizeEndpoint(input.url);
  }
  if (typeof input.name === "string" && input.name.trim()) {
    patch.bucket = input.name.trim();
  }
  if (typeof input.userId === "string" && input.userId.trim()) {
    patch.accessKeyId = input.userId.trim();
  }
  if (typeof input.password === "string" && input.password.trim()) {
    patch.secretAccessKey = input.password.trim();
  }
  if (typeof input.deviceName === "string") {
    const trimmed = input.deviceName.trim();
    patch.serverId = trimmed ? normalizeServerId(trimmed) ?? trimmed : undefined;
  }

  writeSidecarSection(cfg, patch);
  return withChannelSection(cfg, configPointerPatch(cfg));
}

export const r2RelaySetupAdapter: ChannelSetupAdapter = {
  resolveAccountId: () => DEFAULT_ACCOUNT_ID,
  applyAccountConfig: ({ cfg, input }) => applyInputToConfig(cfg, input),
  validateInput: ({ input }) => {
    const url = input.url?.trim() ?? "";
    const bucket = input.name?.trim() ?? "";
    const accessKeyId = input.userId?.trim() ?? "";
    const secretAccessKey = input.password?.trim() ?? "";

    if (!url || !bucket || !accessKeyId || !secretAccessKey) {
      return "R2 endpoint, bucket, access key ID, and secret access key are required.";
    }

    return validateUrl(url) ?? null;
  },
};

export const r2RelaySetupWizard: ChannelSetupWizard = {
  channel: CHANNEL_ID,
  resolveAccountIdForConfigure: () => DEFAULT_ACCOUNT_ID,
  resolveShouldPromptAccountIds: () => false,
  status: {
    configuredLabel: "Configured",
    unconfiguredLabel: "Not configured",
    configuredHint: "R2 endpoint, bucket, and credentials are present.",
    unconfiguredHint: "Add your R2 bucket details to enable the dedicated OpenClaw app flow.",
    resolveConfigured: ({ cfg }) => {
      const section = getSidecarSection(cfg);
      return Boolean(
        section.endpoint?.trim() &&
          section.bucket?.trim() &&
          section.accessKeyId?.trim() &&
          section.secretAccessKey?.trim(),
      );
    },
    resolveStatusLines: ({ cfg, configured }) => {
      const section = getSidecarSection(cfg);
      const lines = [
        configured
          ? "ClawChat and other dedicated clients can use this channel once the gateway is running."
          : "This channel is intended for ClawChat-style dedicated app onboarding.",
      ];
      if (section.bucket?.trim()) {
        lines.push(`Bucket: ${section.bucket.trim()}`);
      }
      if (section.serverId?.trim()) {
        lines.push(`Server ID: ${section.serverId.trim()}`);
      }
      lines.push(`Config file: ${getConfigFilePath(cfg)}`);
      return lines;
    },
  },
  introNote: {
    title: "R2 Relay by ClawChat App",
    lines: [
      "This setup connects OpenClaw to Cloudflare R2 so a dedicated app can discover your gateway and chat through your own bucket.",
      "You will need your R2 endpoint URL, bucket name, access key ID, and secret access key.",
    ],
  },
  stepOrder: "text-first",
  credentials: [],
  textInputs: [
    {
      inputKey: "url",
      message: "R2 endpoint URL",
      placeholder: "https://<account>.r2.cloudflarestorage.com",
      required: true,
      helpTitle: "Endpoint URL",
      helpLines: ["Use the Cloudflare R2 S3-compatible endpoint for your account."],
      currentValue: ({ cfg }) => currentString(cfg, "endpoint"),
      validate: ({ value }) => validateUrl(value.trim()),
      normalizeValue: ({ value }) => normalizeEndpoint(value),
      applySet: ({ cfg, value }) => {
        writeSidecarSection(cfg, { endpoint: normalizeEndpoint(value) });
        return withChannelSection(cfg, { enabled: true, configFile: getConfigFilePath(cfg) });
      },
    },
    {
      inputKey: "name",
      message: "R2 bucket name",
      placeholder: "Bucket name",
      required: true,
      currentValue: ({ cfg }) => currentString(cfg, "bucket"),
      validate: ({ value }) => (value.trim() ? undefined : "Bucket name is required."),
      normalizeValue: ({ value }) => value.trim(),
      applySet: ({ cfg, value }) => {
        writeSidecarSection(cfg, { bucket: value.trim() });
        return withChannelSection(cfg, { enabled: true, configFile: getConfigFilePath(cfg) });
      },
    },
    {
      inputKey: "userId",
      message: "R2 access key ID",
      placeholder: "Access key ID",
      required: true,
      currentValue: ({ cfg }) => currentString(cfg, "accessKeyId"),
      validate: ({ value }) => (value.trim() ? undefined : "Access key ID is required."),
      normalizeValue: ({ value }) => value.trim(),
      applySet: ({ cfg, value }) => {
        writeSidecarSection(cfg, { accessKeyId: value.trim() });
        return withChannelSection(cfg, { enabled: true, configFile: getConfigFilePath(cfg) });
      },
    },
    {
      inputKey: "password",
      message: "R2 secret access key",
      placeholder: "Secret access key",
      required: true,
      currentValue: ({ cfg }) => currentString(cfg, "secretAccessKey"),
      validate: ({ value }) => (value.trim() ? undefined : "Secret access key is required."),
      normalizeValue: ({ value }) => value.trim(),
      applySet: ({ cfg, value }) => {
        writeSidecarSection(cfg, { secretAccessKey: value.trim() });
        return withChannelSection(cfg, { enabled: true, configFile: getConfigFilePath(cfg) });
      },
    },
    {
      inputKey: "deviceName",
      message: "Gateway server ID",
      placeholder: "gateway-home",
      required: false,
      helpTitle: "Server ID",
      helpLines: [
        "This becomes the peer id published to the relay and seen by dedicated clients.",
        "A random candidate name is suggested; you can keep it or edit it.",
      ],
      currentValue: ({ cfg }) => currentString(cfg, "serverId"),
      initialValue: ({ cfg }) => suggestedServerId(cfg),
      normalizeValue: ({ value }) => value.trim(),
      validate: ({ value }) => {
        const trimmed = value.trim();
        if (!trimmed) return undefined;
        return normalizeServerId(trimmed) ? undefined : "Enter a valid server id.";
      },
      applySet: ({ cfg, value }) => {
        const trimmed = value.trim();
        writeSidecarSection(cfg, { serverId: trimmed ? normalizeServerId(trimmed) ?? trimmed : undefined });
        return withChannelSection(cfg, { enabled: true, configFile: getConfigFilePath(cfg) });
      },
    },
  ],
  completionNote: {
    title: "Next step",
    lines: [
      "Restart the gateway after setup so the full plugin runtime loads with your new channel config.",
      "Then use ClawChat or another dedicated OpenClaw app with the same R2 connection details.",
    ],
  },
};
