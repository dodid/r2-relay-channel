import { DEFAULT_ACCOUNT_ID } from "openclaw/plugin-sdk/account-id";
import { defineSetupPluginEntry } from "openclaw/plugin-sdk/core";
import type { ChannelPlugin } from "openclaw/plugin-sdk";
import {
  r2RelayChannelConfigSchema,
  resolveR2RelayAccount,
  type ResolvedR2RelayAccount,
  listR2RelayAccountIds,
} from "./config.js";
import { r2RelaySetupAdapter, r2RelaySetupWizard } from "./setup.js";

const r2RelaySetupPlugin: ChannelPlugin<ResolvedR2RelayAccount> = {
  id: "r2-relay-channel",
  meta: {
    id: "r2-relay-channel",
    label: "R2 Relay",
    selectionLabel: "R2 Relay",
    docsPath: "/channels/r2-relay-channel",
    docsLabel: "r2-relay-channel",
    blurb: "Cloudflare R2-backed relay channel for direct text messaging.",
    order: 120,
  },
  capabilities: {
    chatTypes: ["direct"],
    reactions: true,
    media: false,
  },
  reload: { configPrefixes: ["channels.r2-relay-channel"] },
  configSchema: r2RelayChannelConfigSchema,
  setupWizard: r2RelaySetupWizard,
  setup: r2RelaySetupAdapter,
  config: {
    listAccountIds: (cfg) => listR2RelayAccountIds(cfg),
    resolveAccount: (cfg, accountId) => resolveR2RelayAccount({ cfg, accountId }),
    defaultAccountId: () => DEFAULT_ACCOUNT_ID,
    isConfigured: (account) => account.configured,
    describeAccount: (account) => ({
      accountId: account.accountId,
      enabled: account.enabled,
      configured: account.configured,
      serverId: account.serverId,
      bucket: account.bucket,
      endpoint: redactEndpoint(account.endpoint),
    }),
  },
};

function redactEndpoint(endpoint: string): string {
  try {
    const url = new URL(endpoint);
    return `${url.protocol}//${url.host}`;
  } catch {
    return endpoint;
  }
}

export default defineSetupPluginEntry(r2RelaySetupPlugin);
