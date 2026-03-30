import { DEFAULT_ACCOUNT_ID } from "openclaw/plugin-sdk/account-id";
import type { OpenClawConfig } from "openclaw/plugin-sdk/core";
import type { ChannelSetupAdapter, ChannelSetupInput, ChannelSetupWizard } from "openclaw/plugin-sdk/setup";
import { CHANNEL_ID, DEFAULT_BACKOFF_MAX_MS, DEFAULT_POLL_INTERVAL_MS, DEFAULT_TTL_DAYS, normalizeServerId } from "./config.js";

type ChannelSection = {
  enabled?: boolean;
  endpoint?: string;
  bucket?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  serverId?: string;
  pollIntervalMs?: number;
  backoffMaxMs?: number;
  defaultTtlDays?: number;
};

function getChannelSection(cfg: OpenClawConfig): ChannelSection {
  return ((cfg.channels as Record<string, unknown> | undefined)?.[CHANNEL_ID] as ChannelSection | undefined) ?? {};
}

function withChannelSection(cfg: OpenClawConfig, patch: Partial<ChannelSection>): OpenClawConfig {
  const currentChannels = (cfg.channels as Record<string, unknown> | undefined) ?? {};
  const nextSection: ChannelSection = {
    enabled: true,
    pollIntervalMs: DEFAULT_POLL_INTERVAL_MS,
    backoffMaxMs: DEFAULT_BACKOFF_MAX_MS,
    defaultTtlDays: DEFAULT_TTL_DAYS,
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

function currentString(cfg: OpenClawConfig, key: keyof ChannelSection): string | undefined {
  const value = getChannelSection(cfg)[key];
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

function applyInputToConfig(cfg: OpenClawConfig, input: ChannelSetupInput): OpenClawConfig {
  const patch: Partial<ChannelSection> = {
    enabled: true,
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
  return withChannelSection(cfg, patch);
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
      const section = getChannelSection(cfg);
      return Boolean(
        section.endpoint?.trim() &&
          section.bucket?.trim() &&
          section.accessKeyId?.trim() &&
          section.secretAccessKey?.trim(),
      );
    },
    resolveStatusLines: ({ cfg, configured }) => {
      const section = getChannelSection(cfg);
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
      applySet: ({ cfg, value }) => withChannelSection(cfg, { endpoint: normalizeEndpoint(value) }),
    },
    {
      inputKey: "name",
      message: "R2 bucket name",
      placeholder: "Bucket name",
      required: true,
      currentValue: ({ cfg }) => currentString(cfg, "bucket"),
      validate: ({ value }) => (value.trim() ? undefined : "Bucket name is required."),
      normalizeValue: ({ value }) => value.trim(),
      applySet: ({ cfg, value }) => withChannelSection(cfg, { bucket: value.trim() }),
    },
    {
      inputKey: "userId",
      message: "R2 access key ID",
      placeholder: "Access key ID",
      required: true,
      currentValue: ({ cfg }) => currentString(cfg, "accessKeyId"),
      validate: ({ value }) => (value.trim() ? undefined : "Access key ID is required."),
      normalizeValue: ({ value }) => value.trim(),
      applySet: ({ cfg, value }) => withChannelSection(cfg, { accessKeyId: value.trim() }),
    },
    {
      inputKey: "password",
      message: "R2 secret access key",
      placeholder: "Secret access key",
      required: true,
      currentValue: ({ cfg }) => currentString(cfg, "secretAccessKey"),
      validate: ({ value }) => (value.trim() ? undefined : "Secret access key is required."),
      normalizeValue: ({ value }) => value.trim(),
      applySet: ({ cfg, value }) => withChannelSection(cfg, { secretAccessKey: value.trim() }),
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
        return withChannelSection(cfg, { serverId: trimmed ? normalizeServerId(trimmed) ?? trimmed : undefined });
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
