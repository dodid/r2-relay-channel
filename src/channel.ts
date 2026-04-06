import { DEFAULT_ACCOUNT_ID } from "openclaw/plugin-sdk/account-id";
import {
  buildBaseChannelStatusSummary,
  collectStatusIssuesFromLastError,
  createDefaultChannelRuntimeState,
} from "openclaw/plugin-sdk/status-helpers";
import { dispatchInboundReplyWithBase } from "openclaw/plugin-sdk/nextcloud-talk";
import { jsonResult, readReactionParams, readStringParam } from "openclaw/plugin-sdk/telegram-core";
import { runPassiveAccountLifecycle } from "openclaw/plugin-sdk/channel-lifecycle";
import type { ChannelPlugin } from "openclaw/plugin-sdk";
import {
  DEFAULT_BACKOFF_MAX_MS,
  DEFAULT_POLL_INTERVAL_MS,
  r2RelayChannelConfigSchema,
  resolveR2RelayAccount,
  type ResolvedR2RelayAccount,
  listR2RelayAccountIds,
} from "./config.js";
import { r2RelaySetupAdapter, r2RelaySetupWizard } from "./setup.js";
import fs from "node:fs";
import {
  hasSeenMessage,
  loadCheckpointState,
  rememberMessage,
  saveCheckpointState,
  type RelayCheckpointState,
} from "./checkpoint-store.js";
import { getRelayConfig, getRelayRuntime } from "./runtime.js";
import { IDENTITY_REFRESH_INTERVAL_MS, RELAY_PLUGIN_VERSION, Service } from "./service.js";
import type { IdentitySessionDoc } from "./protocol.js";
import { formatRelayTargetHint, parseRelayTarget } from "./target.js";
import { rememberConversationTarget } from "./conversation-targets.js";

const activeServices = new Map<string, Service>();
const publishedSessionSignatures = new Map<string, string>();
const publishedIdentityAt = new Map<string, number>();

type RelayRuntimeState = Omit<ReturnType<typeof createDefaultChannelRuntimeState>, "running" | "lastStartAt" | "lastStopAt" | "lastError"> & {
  running: boolean;
  lastStartAt: number | null;
  lastStopAt: number | null;
  lastError: string | null;
  serverId: string | null;
  endpoint: string | null;
  bucket: string | null;
  lastPollAt: number | null;
  checkpointHeadKey: string | null;
  lastInboundAt: number | null;
  lastOutboundAt: number | null;
};

const runtimeSnapshots = new Map<string, RelayRuntimeState>();

export const r2RelayPlugin: ChannelPlugin<ResolvedR2RelayAccount> = {
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
  actions: {
    describeMessageTool: () => ({
      actions: ["react"],
    }),
    supportsAction: ({ action }) => action === "react",
    handleAction: async ({ action, params, cfg, accountId }) => {
      const account = resolveR2RelayAccount({ cfg, accountId });
      const service = getOrCreateService(account);

      if (action === "react") {
        const to = readStringParam(params, "to", { required: true });
        const messageId = readStringParam(params, "messageId", { required: true });
        const reaction = readReactionParams(params, {
          removeErrorMessage: "R2 Relay reactions support remove=true only with a specific emoji.",
        });

        const result = await service.sendMessage(
          to.trim(),
          reaction.remove ? "" : reaction.emoji,
          undefined,
          {
            typeOverride: "reaction",
            reactionTargetMessageId: messageId,
            reactionEmoji: reaction.isEmpty ? null : reaction.emoji,
            reactionRemove: reaction.remove || reaction.isEmpty,
          },
        );

        touchRuntime(account.accountId, {
          lastOutboundAt: Date.now(),
          lastError: null,
        });

        return jsonResult({
          ok: true,
          channel: "r2-relay-channel",
          action: "react",
          to: to.trim(),
          messageId: result.messageId,
          targetMessageId: messageId,
          emoji: reaction.emoji,
          remove: reaction.remove || reaction.isEmpty,
        });
      }

      throw new Error(`Unsupported r2-relay-channel action: ${action}`);
    },
  },
  messaging: {
    normalizeTarget: (target) => target.trim(),
    targetResolver: {
      looksLikeId: (input) => Boolean(input.trim()),
      hint: `${formatRelayTargetHint()} or <peer>`,
    },
  },
  outbound: {
    deliveryMode: "direct",
    chunker: (text, limit) => getRelayRuntime().channel.text.chunkText(text, limit),
    chunkerMode: "text",
    textChunkLimit: 4000,
    sendText: async ({ cfg, to, text, accountId }) => {
      const account = resolveR2RelayAccount({ cfg, accountId });
      const service = getOrCreateService(account);
      const target = parseRelayTarget(to);
      const result = await service.sendMessage(target.peer, text, undefined, {
        sessionKey: target.sessionKey,
        sessionId: null,
        serverPeer: account.serverId,
        typeOverride: "text",
      });
      touchRuntime(account.accountId, {
        lastOutboundAt: Date.now(),
        lastError: null,
      });
      return {
        channel: "r2-relay-channel",
        to: to.trim(),
        messageId: result.messageId,
        timestamp: Date.now(),
      };
    },
  },
  status: {
    defaultRuntime: createDefaultRuntimeState(DEFAULT_ACCOUNT_ID) as any,
    collectStatusIssues: (accounts) => collectStatusIssuesFromLastError("r2-relay-channel", accounts),
    buildChannelSummary: ({ snapshot }) => {
      const extended = snapshot as typeof snapshot & Partial<RelayRuntimeState>;
      return {
        ...buildBaseChannelStatusSummary(snapshot),
        serverId: extended.serverId ?? null,
        bucket: extended.bucket ?? null,
        endpoint: extended.endpoint ?? null,
        lastPollAt: extended.lastPollAt ?? null,
        checkpointHeadKey: extended.checkpointHeadKey ?? null,
        lastInboundAt: extended.lastInboundAt ?? null,
        lastOutboundAt: extended.lastOutboundAt ?? null,
      };
    },
    buildAccountSnapshot: ({ account, runtime }) => {
      const extendedRuntime = (runtime ?? null) as Partial<RelayRuntimeState> | null;
      return {
        accountId: account.accountId,
        enabled: account.enabled,
        configured: account.configured,
        running: runtime?.running ?? false,
        lastStartAt: runtime?.lastStartAt ?? null,
        lastStopAt: runtime?.lastStopAt ?? null,
        lastError: runtime?.lastError ?? null,
        lastPollAt: extendedRuntime?.lastPollAt ?? null,
        lastInboundAt: extendedRuntime?.lastInboundAt ?? null,
        lastOutboundAt: extendedRuntime?.lastOutboundAt ?? null,
        serverId: account.serverId,
        bucket: account.bucket,
        endpoint: redactEndpoint(account.endpoint),
        checkpointHeadKey: extendedRuntime?.checkpointHeadKey ?? null,
      };
    },
  },
  gateway: {
    startAccount: async (ctx) => {
      const account = ctx.account;
      const runtime = createDefaultRuntimeState(account.accountId);
      runtime.serverId = account.serverId;
      runtime.bucket = account.bucket;
      runtime.endpoint = redactEndpoint(account.endpoint);
      runtimeSnapshots.set(account.accountId, runtime);
      ctx.setStatus({
        accountId: account.accountId,
      } as any);

      return runPassiveAccountLifecycle({
        abortSignal: ctx.abortSignal,
        start: async () => {
          const service = getOrCreateService(account);
          activeServices.set(account.accountId, service);
          await syncPublishedIdentity(service, account, true);
          void runSweeperLoop({
            account,
            service,
            abortSignal: ctx.abortSignal,
            log: ctx.log,
          });
          touchRuntime(account.accountId, {
            running: true as any,
            lastStartAt: Date.now() as any,
            lastError: null,
            serverId: account.serverId,
            bucket: account.bucket,
            endpoint: redactEndpoint(account.endpoint),
          });
          ctx.setStatus({
            accountId: account.accountId,
          } as any);

          const state = await loadCheckpointState(account.accountId);
          await pollRelayInbox({
            cfg: ctx.cfg as any,
            account,
            service,
            abortSignal: ctx.abortSignal,
            log: ctx.log,
            setStatus: ctx.setStatus as any,
            state,
          });
          return { service };
        },
        stop: async () => {
          activeServices.delete(account.accountId);
          touchRuntime(account.accountId, {
            running: false,
            lastStopAt: Date.now() as any,
          });
        },
      });
    },
  },
};

function createDefaultRuntimeState(accountId: string): RelayRuntimeState {
  return createDefaultChannelRuntimeState(accountId, {
    serverId: null,
    endpoint: null,
    bucket: null,
    lastPollAt: null,
    checkpointHeadKey: null,
    lastInboundAt: null,
    lastOutboundAt: null,
  });
}

function getOrCreateService(account: ResolvedR2RelayAccount): Service {
  const existing = activeServices.get(account.accountId);
  if (existing) {
    return existing;
  }
  const created = new Service({
    endpoint: account.endpoint,
    bucket: account.bucket,
    region: account.region,
    accessKeyId: account.accessKeyId,
    secretAccessKey: account.secretAccessKey,
    forcePathStyle: account.forcePathStyle,
    peerId: account.serverId,
  });
  activeServices.set(account.accountId, created);
  return created;
}

async function pollRelayInbox(params: {
  cfg: Record<string, unknown>;
  account: ResolvedR2RelayAccount;
  service: Service;
  abortSignal?: AbortSignal;
  log?: {
    info?: (message: string, meta?: Record<string, unknown>) => void;
    debug?: (message: string, meta?: Record<string, unknown>) => void;
    warn?: (message: string, meta?: Record<string, unknown>) => void;
    error?: (message: string, meta?: Record<string, unknown>) => void;
  };
  setStatus: (patch: any) => void;
  state: RelayCheckpointState;
}): Promise<void> {
  const { cfg, account, service, abortSignal, log, setStatus } = params;
  let interval = account.pollIntervalMs || DEFAULT_POLL_INTERVAL_MS;
  let state = params.state;

  while (!abortSignal?.aborted) {
    try {
      const batch = await service.collectInboxMessages(account.serverId, state.lastHeadKey);
      const now = Date.now();
      state = { ...state, lastPollAt: now };
      touchRuntime(account.accountId, {
        lastPollAt: now,
        checkpointHeadKey: state.lastHeadKey,
      });
      setStatus({
        accountId: account.accountId,
        lastPollAt: now,
        checkpointHeadKey: state.lastHeadKey,
      });

      if (batch.messages.length > 0) {
        for (const item of batch.messages) {
          if (abortSignal?.aborted) {
            break;
          }

          const msg = item.message;
          if (msg.from === account.serverId) {
            await service.markMessageProcessed(item.key, {
              processedState: "self",
              processedBy: account.serverId,
            });
            state = rememberMessage(state, {
              msgId: msg.msg_id,
              objectKey: item.key,
              at: msg.ts_sent,
            });
            continue;
          }
          if (msg.to !== account.serverId) {
            continue;
          }
          if (hasSeenMessage(state, { msgId: msg.msg_id, objectKey: item.key })) {
            continue;
          }

          if (msg.type !== "reaction") {
            try {
              await sendProcessedConfirmation({
                account,
                service,
                targetPeer: msg.from,
                targetMessageId: msg.msg_id,
                sessionKey: msg.session_key ?? null,
                sessionId: msg.session_id ?? null,
              });
            } catch (confirmErr) {
              log?.warn?.(`[${account.accountId}] failed to send processed confirmation: ${confirmErr instanceof Error ? confirmErr.message : String(confirmErr)}`);
            }
          }

          await dispatchInboundMessage({
            cfg,
            account,
            service,
            text: formatInboundRelayBody(msg),
            senderId: msg.from,
            timestamp: msg.ts_sent || Date.now(),
            messageId: msg.msg_id,
            sessionKey: msg.session_key ?? null,
            sessionId: msg.session_id ?? null,
          });

          state = rememberMessage(state, {
            msgId: msg.msg_id,
            objectKey: item.key,
            at: msg.ts_sent,
          });
          touchRuntime(account.accountId, {
            lastInboundAt: msg.ts_sent || Date.now(),
            lastError: null,
          });
          setStatus({
            accountId: account.accountId,
            lastInboundAt: msg.ts_sent || Date.now(),
            lastError: null,
          });
        }

        state = {
          ...state,
          lastHeadKey: batch.head?.head_key ?? state.lastHeadKey,
        };
        await saveCheckpointState(state, account.accountId);
        touchRuntime(account.accountId, {
          checkpointHeadKey: state.lastHeadKey,
          lastPollAt: state.lastPollAt,
          lastInboundAt: state.lastInboundAt,
        });
        setStatus({
          accountId: account.accountId,
          checkpointHeadKey: state.lastHeadKey,
          lastPollAt: state.lastPollAt,
          lastInboundAt: state.lastInboundAt,
        });
        interval = account.pollIntervalMs || DEFAULT_POLL_INTERVAL_MS;
      }

      await syncPublishedIdentity(service, account);
      await sleep(interval, abortSignal);
      if (!batch.head?.head_key) {
        interval = Math.min(interval * 2, account.backoffMaxMs || DEFAULT_BACKOFF_MAX_MS);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      touchRuntime(account.accountId, { lastError: message });
      setStatus({ accountId: account.accountId, lastError: message });
      log?.error?.(`[${account.accountId}] relay poll failed: ${message}`);
      await saveCheckpointState(state, account.accountId);
      await sleep(interval, abortSignal);
      interval = Math.min(interval * 2, account.backoffMaxMs || DEFAULT_BACKOFF_MAX_MS);
    }
  }

  await saveCheckpointState(state, account.accountId);
}

async function dispatchInboundMessage(params: {
  cfg: Record<string, unknown>;
  account: ResolvedR2RelayAccount;
  service: Service;
  senderId: string;
  text: string;
  timestamp: number;
  messageId: string;
  sessionKey?: string | null;
  sessionId?: string | null;
}): Promise<void> {
  const core = getRelayRuntime();
  const resolvedRoute = core.channel.routing.resolveAgentRoute({
    cfg: params.cfg as any,
    channel: "r2-relay-channel",
    accountId: params.account.accountId,
    peer: {
      kind: "direct",
      id: params.senderId,
    },
  });
  const route = params.sessionKey?.trim()
    ? {
        ...resolvedRoute,
        agentId: agentIdFromSessionKey(params.sessionKey.trim()),
        sessionKey: params.sessionKey.trim(),
      }
    : resolvedRoute;

  const storePath = core.channel.session.resolveStorePath(
    (params.cfg as { session?: { store?: string } }).session?.store,
    {
      agentId: route.agentId,
    },
  );

  const envelopeOptions = core.channel.reply.resolveEnvelopeFormatOptions(params.cfg as any);
  const previousTimestamp = core.channel.session.readSessionUpdatedAt({
    storePath,
    sessionKey: route.sessionKey,
  });
  const body = core.channel.reply.formatAgentEnvelope({
    channel: "R2 Relay",
    from: params.senderId,
    timestamp: params.timestamp,
    previousTimestamp,
    envelope: envelopeOptions,
    body: params.text,
  });

  const ctxPayload = core.channel.reply.finalizeInboundContext({
    Body: body,
    BodyForAgent: params.text,
    RawBody: params.text,
    CommandBody: params.text,
    CommandAuthorized: true,
    From: `r2-relay-channel:${params.senderId}`,
    To: `r2-relay-channel:${params.account.serverId}`,
    SessionKey: route.sessionKey,
    AccountId: route.accountId,
    ChatType: "direct",
    ConversationLabel: params.senderId,
    SenderId: params.senderId,
    Provider: "r2-relay-channel",
    Surface: "r2-relay-channel",
    MessageSid: params.messageId,
    Timestamp: params.timestamp,
    OriginatingChannel: "r2-relay-channel",
    OriginatingTo: `r2-relay-channel:${params.account.serverId}`,
  });

  rememberConversationTarget({
    channel: "r2-relay-channel",
    accountId: params.account.accountId,
    conversationId: ctxPayload.From,
    threadId: null,
    peer: params.senderId,
    sessionKey: route.sessionKey,
  });

  const sessionEntry = await readPublishedSessionEntry(route.sessionKey);
  const outboundMeta = {
    sessionKey: route.sessionKey,
    sessionId: params.sessionId ?? sessionEntry?.session_id ?? null,
    serverPeer: params.account.serverId,
  };
  const createStreamId = () => `stream-${params.messageId}-${Date.now()}`;
  const streamState = {
    streamId: createStreamId(),
    seq: 0,
    lastText: "",
    lastEmitAt: 0,
    active: false,
  };
  const partialIntervalMs = 2000;
  const partialMinGrowthChars = 120;

  const resetStream = () => {
    streamState.streamId = createStreamId();
    streamState.seq = 0;
    streamState.lastText = "";
    streamState.lastEmitAt = 0;
    streamState.active = false;
  };

  const normalizeStreamText = (text: string) => text.replace(/\r\n/g, "\n");

  const emitPartialSnapshot = async (text: string) => {
    const normalized = normalizeStreamText(text);
    if (!normalized.trim()) {
      return;
    }
    if (streamState.active && normalized === streamState.lastText) {
      return;
    }
    if (streamState.active && streamState.lastText && !normalized.startsWith(streamState.lastText)) {
      return;
    }
    if (!streamState.active) {
      streamState.streamId = createStreamId();
      streamState.seq = 0;
      streamState.lastText = "";
      streamState.lastEmitAt = 0;
      streamState.active = true;
    }
    streamState.seq += 1;
    streamState.lastText = normalized;
    streamState.lastEmitAt = Date.now();
    await params.service.sendMessage(
      params.senderId,
      normalized,
      undefined,
      {
        ...outboundMeta,
        streamId: streamState.streamId,
        streamSeq: streamState.seq,
        streamState: "partial",
        typeOverride: "assistant_stream",
      },
    );
    touchRuntime(params.account.accountId, {
      lastOutboundAt: Date.now(),
      lastError: null,
    });
  };

  const emitFinalMessage = async (text: string) => {
    const normalized = normalizeStreamText(text);
    if (!normalized.trim()) {
      return;
    }

    if (streamState.active) {
      if (streamState.lastText && !normalized.startsWith(streamState.lastText)) {
        return;
      }
      streamState.lastText = normalized;
      streamState.lastEmitAt = Date.now();
    }

    await params.service.sendMessage(
      params.senderId,
      normalized,
      undefined,
      {
        ...outboundMeta,
        typeOverride: "text",
        streamId: null,
        streamSeq: null,
        streamState: null,
      },
    );
    touchRuntime(params.account.accountId, {
      lastOutboundAt: Date.now(),
      lastError: null,
    });
    resetStream();
  };

  await dispatchInboundReplyWithBase({
    cfg: params.cfg as any,
    channel: "r2-relay-channel",
    accountId: params.account.accountId,
    route,
    storePath,
    ctxPayload,
    core,
    deliver: async (payload) => {
      const text = payload.text ?? "";
      await emitFinalMessage(text);
    },
    onRecordError: () => {},
    onDispatchError: (err) => {
      throw err instanceof Error ? err : new Error(String(err));
    },
    replyOptions: {
      onAssistantMessageStart: async () => {},
      onReasoningEnd: async () => {},
      onPartialReply: async (payload) => {
        const text = payload.text ?? "";
        const normalized = normalizeStreamText(text);
        if (!normalized.trim()) {
          return;
        }
        if (streamState.active && normalized === streamState.lastText) {
          return;
        }
        const now = Date.now();
        const growth = normalized.length - streamState.lastText.length;
        const enoughTimePassed = now - streamState.lastEmitAt >= partialIntervalMs;
        const enoughGrowth = growth >= partialMinGrowthChars;
        if (!enoughTimePassed && !enoughGrowth) {
          return;
        }
        await emitPartialSnapshot(normalized);
      },
    },
  });
}

function touchRuntime(
  accountId: string,
  patch: Partial<RelayRuntimeState>,
): void {
  const current = runtimeSnapshots.get(accountId) ?? createDefaultRuntimeState(accountId);
  runtimeSnapshots.set(accountId, {
    ...current,
    ...patch,
  });
}

async function syncPublishedIdentity(service: Service, account: ResolvedR2RelayAccount, force = false): Promise<void> {
  const sessions = await collectPublishedSessions(account);
  const modelCapabilities = await collectPublishedModelCapabilities(account);
  const signature = JSON.stringify({ sessions, modelCapabilities });
  const now = Date.now();
  const lastPublishedAt = publishedIdentityAt.get(account.accountId) ?? 0;
  const needsRefresh = now - lastPublishedAt >= IDENTITY_REFRESH_INTERVAL_MS;
  if (!force && !needsRefresh && publishedSessionSignatures.get(account.accountId) === signature) {
    return;
  }
  publishedSessionSignatures.set(account.accountId, signature);
  publishedIdentityAt.set(account.accountId, now);
  await service.publishIdentity({
    peer: account.serverId,
    display_name: deriveGatewayDisplayName(account.serverId),
    role: "server",
    plugin_version: RELAY_PLUGIN_VERSION,
    capabilities: ["text", "protocol:v1", "session-selection:v1"],
    contact: null,
    last_seen: now,
    sessions,
    agent_capabilities: modelCapabilities ? { models: modelCapabilities } : undefined,
  });
}

async function collectPublishedModelCapabilities(_account: ResolvedR2RelayAccount): Promise<{ available: { id: string; label?: string | null; provider?: string | null }[]; default?: string | null } | null> {
  try {
    const cfg = getRelayConfig();
    const configuredModels = cfg.agents?.defaults?.models;
    if (!configuredModels || typeof configuredModels !== "object") {
      return null;
    }
    const available = Object.entries(configuredModels).map(([key]) => ({
      id: key,
      provider: key.includes("/") ? key.split("/")[0] : null,
    }));
    const modelConfig = cfg.agents?.defaults?.model;
    const defaultModel = typeof modelConfig === "string"
      ? modelConfig
      : modelConfig && typeof modelConfig.primary === "string"
        ? modelConfig.primary
        : null;
    return available.length > 0 ? { available, default: defaultModel } : null;
  } catch {
    return null;
  }
}

async function collectPublishedSessions(_account: ResolvedR2RelayAccount): Promise<IdentitySessionDoc[]> {
  const sessions: IdentitySessionDoc[] = [];

  for (const agentId of listConfiguredAgentIds()) {
    let hasMainSession = false;
    try {
      const store = await readPublishedSessionStore(agentId);
      for (const [sessionKey, entry] of Object.entries(store)) {
        if (typeof sessionKey !== "string" || !sessionKey.startsWith(`agent:${agentId}:`)) {
          continue;
        }
        if (sessionKey === `agent:${agentId}:main`) {
          hasMainSession = true;
        }
        sessions.push(identitySessionDocFromEntry(sessionKey, entry));
      }
    } catch {
      // No session store yet for this agent; still publish its synthetic main chat.
    }

    if (!hasMainSession) {
      sessions.push(syntheticMainSessionDoc(agentId));
    }
  }

  return sessions.sort((a, b) => (b.updated_at ?? 0) - (a.updated_at ?? 0));
}

function listConfiguredAgentIds(): string[] {
  const cfg = getRelayConfig() as { agents?: { list?: Array<{ id?: string | null }> } };
  const ids = new Set<string>(["main"]);
  for (const agent of cfg.agents?.list ?? []) {
    const id = agent?.id?.trim();
    if (id) {
      ids.add(id);
    }
  }
  return Array.from(ids);
}

function agentIdFromSessionKey(sessionKey: string): string {
  const parts = sessionKey.split(":");
  if (parts.length >= 2 && parts[0] === "agent" && parts[1]?.trim()) {
    return parts[1].trim();
  }
  return "main";
}

function identitySessionDocFromEntry(sessionKey: string, entry: any): IdentitySessionDoc {
  return {
    session_key: sessionKey,
    session_id: typeof entry?.sessionId === "string" ? entry.sessionId : null,
    updated_at: typeof entry?.updatedAt === "number" ? entry.updatedAt : null,
    chat_type: typeof entry?.chatType === "string" ? entry.chatType : null,
    channel:
      typeof entry?.lastChannel === "string"
        ? entry.lastChannel
        : typeof entry?.deliveryContext?.channel === "string"
          ? entry.deliveryContext.channel
          : null,
    account_id:
      typeof entry?.lastAccountId === "string"
        ? entry.lastAccountId
        : typeof entry?.deliveryContext?.accountId === "string"
          ? entry.deliveryContext.accountId
          : null,
  };
}

function syntheticMainSessionDoc(agentId: string): IdentitySessionDoc {
  return {
    session_key: `agent:${agentId}:main`,
    session_id: null,
    updated_at: null,
    chat_type: "direct",
    channel: null,
    account_id: null,
  };
}

async function readPublishedSessionStore(agentId = "main"): Promise<Record<string, any>> {
  const storePath = getRelayRuntime().channel.session.resolveStorePath(undefined, {
    agentId,
  });
  const raw = await fs.promises.readFile(storePath, "utf8");
  return JSON.parse(raw) as Record<string, any>;
}

async function readPublishedSessionEntry(sessionKey: string): Promise<IdentitySessionDoc | null> {
  const agentId = agentIdFromSessionKey(sessionKey);
  const syntheticMain = sessionKey === `agent:${agentId}:main` ? syntheticMainSessionDoc(agentId) : null;
  try {
    const store = await readPublishedSessionStore(agentId);
    const entry = store[sessionKey];
    if (!entry) {
      return syntheticMain;
    }
    return identitySessionDocFromEntry(sessionKey, entry);
  } catch {
    return syntheticMain;
  }
}

async function sendProcessedConfirmation(params: {
  account: ResolvedR2RelayAccount;
  service: Service;
  targetPeer: string;
  targetMessageId: string;
  sessionKey?: string | null;
  sessionId?: string | null;
}): Promise<void> {
  await params.service.sendMessage(
    params.targetPeer,
    "✅",
    undefined,
    {
      sessionKey: params.sessionKey ?? null,
      sessionId: params.sessionId ?? null,
      serverPeer: params.account.serverId,
      typeOverride: "reaction",
      reactionTargetMessageId: params.targetMessageId,
      reactionEmoji: "✅",
      reactionRemove: false,
    },
  );
}

function formatInboundRelayBody(msg: {
  type?: string;
  body?: string;
  reaction_emoji?: string | null;
  reaction_target_msg_id?: string | null;
  reaction_remove?: boolean | null;
}): string {
  if (msg.type !== "reaction") {
    return msg.body ?? "";
  }

  const emoji = msg.reaction_emoji ?? msg.body ?? "";
  const target = msg.reaction_target_msg_id ?? "unknown";
  return msg.reaction_remove
    ? `Reaction removed: ${emoji || "(cleared)"} on msg ${target}`
    : `Reaction added: ${emoji || "(empty)"} on msg ${target}`;
}

async function runSweeperLoop(params: {
  account: ResolvedR2RelayAccount;
  service: Service;
  abortSignal?: AbortSignal;
  log?: {
    info?: (message: string, meta?: Record<string, unknown>) => void;
    debug?: (message: string, meta?: Record<string, unknown>) => void;
    warn?: (message: string, meta?: Record<string, unknown>) => void;
    error?: (message: string, meta?: Record<string, unknown>) => void;
  };
}): Promise<void> {
  await sleep(60_000, params.abortSignal);
  while (!params.abortSignal?.aborted) {
    try {
      const summaries = await params.service.sweepRetention(params.account.ttl, params.abortSignal);
      const summaryText = summaries.map((item) => `${item.prefix} scanned=${item.scanned} deleted=${item.deleted}`).join("; ");
      params.log?.info?.(`[${params.account.accountId}] relay sweeper complete${summaryText ? `: ${summaryText}` : ""}`);
    } catch (err) {
      params.log?.warn?.(`[${params.account.accountId}] relay sweeper failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    await sleep(24 * 60 * 60 * 1000, params.abortSignal);
  }
}

function deriveGatewayDisplayName(serverId: string): string {
  const cfg = getRelayConfig();
  const candidates = [
    (cfg as { identity?: { name?: string } }).identity?.name,
    (cfg as { agents?: { main?: { name?: string } } }).agents?.main?.name,
    (cfg as { assistant?: { name?: string } }).assistant?.name,
    (cfg as { gateway?: { name?: string } }).gateway?.name,
  ];
  for (const candidate of candidates) {
    const trimmed = candidate?.trim();
    if (trimmed) {
      return trimmed;
    }
  }
  return serverId
    .replace(/[-_.]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (ch) => ch.toUpperCase()) || "Gateway";
}

function redactEndpoint(endpoint: string): string {
  try {
    const url = new URL(endpoint);
    return `${url.protocol}//${url.host}`;
  } catch {
    return endpoint;
  }
}

function sleep(ms: number, abortSignal?: AbortSignal): Promise<void> {
  if (ms <= 0) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      abortSignal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      abortSignal?.removeEventListener("abort", onAbort);
      resolve();
    };
    abortSignal?.addEventListener("abort", onAbort, { once: true });
  });
}
