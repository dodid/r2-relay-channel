import { DEFAULT_ACCOUNT_ID } from "openclaw/plugin-sdk/account-id";
import {
  buildBaseChannelStatusSummary,
  collectStatusIssuesFromLastError,
  createDefaultChannelRuntimeState,
} from "openclaw/plugin-sdk/status-helpers";
import { createChannelReplyPipeline } from "openclaw/plugin-sdk/channel-reply-pipeline";
import { runPassiveAccountLifecycle } from "openclaw/plugin-sdk/channel-lifecycle";
import { MAX_AUDIO_BYTES, MAX_DOCUMENT_BYTES, MAX_IMAGE_BYTES, MAX_VIDEO_BYTES } from "openclaw/plugin-sdk/media-runtime";
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
import os from "node:os";
import path from "node:path";
import {
  hasSeenMessage,
  loadCheckpointState,
  rememberMessage,
  saveCheckpointState,
  type RelayCheckpointState,
} from "./checkpoint-store.js";
import { getRelayConfig, getRelayRuntime } from "./runtime.js";
import { IDENTITY_REFRESH_INTERVAL_MS, RELAY_PLUGIN_VERSION, Service } from "./service.js";
import type { AttachmentRef, IdentityServerLimitsDoc, IdentitySessionDoc } from "./protocol.js";
import { formatRelayTargetHint, parseRelayTarget } from "./target.js";
import { rememberConversationTarget } from "./conversation-targets.js";

const activeServices = new Map<string, Service>();
const publishedSessionSignatures = new Map<string, string>();
const publishedIdentityAt = new Map<string, number>();

function jsonResult(payload: Record<string, unknown>) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(payload, null, 2),
      },
    ],
    details: payload,
    channelData: payload,
  };
}

function readStringParam(
  params: Record<string, unknown>,
  key: string,
  options?: { required?: boolean },
): string {
  const value = params[key];
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.length > 0 || !options?.required) {
      return trimmed;
    }
  }
  if (options?.required) {
    throw new Error(`Missing required parameter: ${key}`);
  }
  return "";
}

function readBooleanParam(params: Record<string, unknown>, key: string): boolean {
  const value = params[key];
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    return value !== 0;
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["1", "true", "yes", "y", "on"].includes(normalized)) {
      return true;
    }
    if (["0", "false", "no", "n", "off", ""].includes(normalized)) {
      return false;
    }
  }
  return false;
}

function readReactionParams(
  params: Record<string, unknown>,
  options?: { removeErrorMessage?: string },
): { emoji: string; remove: boolean; isEmpty: boolean } {
  const emoji = readStringParam(params, "emoji") || readStringParam(params, "reaction");
  const remove = readBooleanParam(params, "remove");
  const isEmpty = emoji.length === 0;

  if (remove && isEmpty) {
    throw new Error(options?.removeErrorMessage ?? "remove=true requires a specific emoji.");
  }
  if (!remove && isEmpty) {
    throw new Error("Missing required parameter: emoji");
  }

  return { emoji, remove, isEmpty };
}

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
    media: true,
  },
  execApprovals: {
    getInitiatingSurfaceState: ({ cfg, accountId }) => {
      const account = resolveR2RelayAccount({ cfg, accountId });
      if (!account.enabled || !account.configured) {
        return { kind: "disabled" };
      }
      return { kind: "enabled" };
    },
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
      return sendRelayPayloadMessage({
        cfg,
        to,
        payload: { text },
        accountId,
        source: "sendText",
      });
    },
    sendMedia: async ({ cfg, to, text, mediaUrl, accountId }) => {
      return sendRelayPayloadMessage({
        cfg,
        to,
        payload: {
          text,
          mediaUrl,
        },
        accountId,
        source: "sendMedia",
      });
    },
    sendPayload: async ({ cfg, to, payload, accountId }) => {
      return sendRelayPayloadMessage({
        cfg,
        to,
        payload,
        accountId,
        source: "sendPayload",
      });
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

type RelayPollLog = {
  info?: (message: string, meta?: Record<string, unknown>) => void;
  debug?: (message: string, meta?: Record<string, unknown>) => void;
  warn?: (message: string, meta?: Record<string, unknown>) => void;
  error?: (message: string, meta?: Record<string, unknown>) => void;
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

function emitRelayDebug(log: RelayPollLog | undefined, message: string, meta?: Record<string, unknown>) {
  if (log?.info) {
    log.info(message, meta);
    return;
  }
  if (log?.debug) {
    log.debug(message, meta);
    return;
  }
  if (meta) {
    console.log(message, JSON.stringify(meta));
    return;
  }
  console.log(message);
}

function summarizeRelayMessageForLog(msg: {
  msg_id?: string | null;
  type?: string | null;
  from?: string | null;
  to?: string | null;
  session_key?: string | null;
  session_id?: string | null;
  attachments?: { key?: string | null }[] | null;
  processed_state?: string | null;
}) {
  return {
    msgId: msg.msg_id ?? null,
    type: msg.type ?? "text",
    from: msg.from ?? null,
    to: msg.to ?? null,
    sessionKey: msg.session_key ?? null,
    sessionId: msg.session_id ?? null,
    attachmentCount: msg.attachments?.length ?? 0,
    processedState: msg.processed_state ?? null,
  };
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
  log?: RelayPollLog;
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
        let batchFailed = false;

        for (const item of batch.messages) {
          if (abortSignal?.aborted) {
            break;
          }

          const msg = item.message;
          try {
            emitRelayDebug(log, `[${account.accountId}] evaluating inbound relay message`, {
              objectKey: item.key,
              ...summarizeRelayMessageForLog(msg),
            });
            if (msg.from === account.serverId) {
              emitRelayDebug(log, `[${account.accountId}] skipping self-authored relay message`, {
                objectKey: item.key,
                ...summarizeRelayMessageForLog(msg),
              });
              await service.markMessageProcessed(item.key, {
                processedState: "self",
                processedBy: account.serverId,
              });
              state = rememberMessage(state, {
                msgId: msg.msg_id,
                objectKey: item.key,
                at: msg.ts_sent,
              });
              state = { ...state, lastHeadKey: item.key };
              continue;
            }
            if (msg.to !== account.serverId) {
              emitRelayDebug(log, `[${account.accountId}] skipping relay message addressed to different peer`, {
                objectKey: item.key,
                expectedTo: account.serverId,
                ...summarizeRelayMessageForLog(msg),
              });
              state = { ...state, lastHeadKey: item.key };
              continue;
            }
            if (hasSeenMessage(state, { msgId: msg.msg_id, objectKey: item.key })) {
              emitRelayDebug(log, `[${account.accountId}] skipping already-seen relay message`, {
                objectKey: item.key,
                ...summarizeRelayMessageForLog(msg),
              });
              state = { ...state, lastHeadKey: item.key };
              continue;
            }

            let processedState = "processed";
            try {
              await dispatchInboundMessage({
                cfg,
                account,
                service,
                log,
                text: formatInboundRelayBody(msg),
                senderId: msg.from,
                timestamp: msg.ts_sent || Date.now(),
                messageId: msg.msg_id,
                sessionKey: msg.session_key ?? null,
                sessionId: msg.session_id ?? null,
                attachments: msg.attachments ?? [],
              });

              emitRelayDebug(log, `[${account.accountId}] dispatched inbound relay message to gateway`, {
                objectKey: item.key,
                ...summarizeRelayMessageForLog(msg),
              });
            } catch (messageErr) {
              const message = messageErr instanceof Error ? messageErr.message : String(messageErr);
              processedState = classifyInboundRelayMessageFailure(messageErr);
              touchRuntime(account.accountId, { lastError: message });
              setStatus({ accountId: account.accountId, lastError: message });
              log?.error?.(
                `[${account.accountId}] relay inbound handling failed for ${item.key}: ${message}`,
                {
                  ...summarizeRelayMessageForLog(msg),
                  objectKey: item.key,
                  processedState,
                },
              );
            }

            try {
              await service.markMessageProcessed(item.key, {
                processedState,
                processedBy: account.serverId,
              });
            } catch (markErr) {
              log?.warn?.(`[${account.accountId}] failed to persist processed state for ${item.key}: ${markErr instanceof Error ? markErr.message : String(markErr)}`);
            }

            state = rememberMessage(state, {
              msgId: msg.msg_id,
              objectKey: item.key,
              at: msg.ts_sent,
            });
            state = { ...state, lastHeadKey: item.key };
            touchRuntime(account.accountId, {
              lastInboundAt: msg.ts_sent || Date.now(),
              checkpointHeadKey: state.lastHeadKey,
              lastError: processedState === "processed" ? null : runtimeSnapshots.get(account.accountId)?.lastError ?? null,
            });
            setStatus({
              accountId: account.accountId,
              lastInboundAt: msg.ts_sent || Date.now(),
              checkpointHeadKey: state.lastHeadKey,
              lastError: processedState === "processed" ? null : runtimeSnapshots.get(account.accountId)?.lastError ?? null,
            });
          } catch (messageErr) {
            const message = messageErr instanceof Error ? messageErr.message : String(messageErr);
            touchRuntime(account.accountId, { lastError: message });
            setStatus({ accountId: account.accountId, lastError: message });
            log?.error?.(
              `[${account.accountId}] relay inbound handling failed for ${item.key}: ${message}`,
            );
            batchFailed = true;
            break;
          }
        }

        if (!batchFailed) {
          state = {
            ...state,
            lastHeadKey: batch.head?.head_key ?? state.lastHeadKey,
          };
        }
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
        if (!batchFailed) {
          interval = account.pollIntervalMs || DEFAULT_POLL_INTERVAL_MS;
        }
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
  log?: RelayPollLog;
  senderId: string;
  text: string;
  timestamp: number;
  messageId: string;
  sessionKey?: string | null;
  sessionId?: string | null;
  attachments?: AttachmentRef[];
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

  const attachmentContext = formatAttachmentContext(params.attachments);
  const agentText = attachmentContext
    ? `${params.text}\n\n${attachmentContext}`
    : params.text;

  // Stage all inbound attachments locally so OpenClaw sees real media/files
  // instead of only attachment manifest text.
  const mediaUrls: string[] = [];
  const mediaPaths: string[] = [];
  const mediaTypes: string[] = [];
  if (params.attachments) {
    const logger = getRelayRuntime().logging.getChildLogger();
    for (const att of params.attachments) {
      if (!att.key) {
        continue;
      }

      const maxBytes = resolveInboundAttachmentMaxBytes(att);
      const bestEffortMaxBytes = resolveInboundAttachmentBestEffortMaxBytes(att, maxBytes);
      try {
        logger.info(
          `[${params.account.accountId}] staging inbound relay attachment key=${att.key} name=${att.file_name ?? ""} type=${att.content_type ?? ""} kind=${att.kind ?? "unknown"} declaredSize=${att.size ?? -1} maxBytes=${maxBytes} bestEffortMaxBytes=${bestEffortMaxBytes}`,
        );
        logger.info(`[${params.account.accountId}] inbound relay attachment fetching object key=${att.key}`);
        const fetchedObject = await params.service.getAttachmentObject(att.key);
        if (!fetchedObject?.Body) {
          throw new Error(`AttachmentNotFound: key=${att.key}`);
        }
        const chunks: Buffer[] = [];
        let total = 0;
        let nextProgressBytes = 1024 * 1024;
        for await (const chunk of fetchedObject.Body as AsyncIterable<Uint8Array | Buffer | string>) {
          const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
          chunks.push(buf);
          total += buf.length;
          if (total >= nextProgressBytes) {
            logger.info(
              `[${params.account.accountId}] inbound relay attachment streaming progress key=${att.key} downloadedBytes=${total} declaredSize=${att.size ?? -1}`,
            );
            nextProgressBytes += 1024 * 1024;
          }
          if (total > bestEffortMaxBytes) {
            throw new Error(`AttachmentTooLarge: streamedSize>${bestEffortMaxBytes}`);
          }
        }
        const buffer = Buffer.concat(chunks);
        logger.info(`[${params.account.accountId}] inbound relay attachment fetched object key=${att.key} bytes=${buffer.length}`);
        const contentType = normalizeAttachmentContentType(
          fetchedObject.ContentType,
          att.content_type,
          att.file_name,
        );
        const saved = await core.channel.media.saveMediaBuffer(
          buffer,
          contentType,
          "inbound",
          bestEffortMaxBytes,
          att.file_name ?? undefined,
        );

        mediaUrls.push(`r2://${att.key}`);
        mediaPaths.push(saved.path);
        mediaTypes.push(saved.contentType ?? contentType ?? att.content_type ?? "application/octet-stream");
        logger.info(
          `[${params.account.accountId}] staged inbound relay attachment key=${att.key} savedPath=${saved.path} savedType=${saved.contentType ?? contentType ?? att.content_type ?? "application/octet-stream"} bytes=${buffer.length}`,
        );
      } catch (err) {
        getRelayRuntime().logging.getChildLogger().error(
          `[${params.account.accountId}] failed to stage inbound relay attachment ${att.key}: ${String(err)}`,
        );
      }
    }
  }

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
    body: agentText,
  });

  const ctxPayload = core.channel.reply.finalizeInboundContext({
    Body: body,
    BodyForAgent: agentText,
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
    ...(mediaPaths.length > 0 ? {
      MediaPath: mediaPaths[0],
      MediaPaths: mediaPaths,
      MediaUrls: mediaUrls,
      MediaTypes: mediaTypes,
      MediaUrl: mediaUrls[0],
      MediaType: mediaTypes[0]
    } : {}),
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
    try {
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
      emitRelayDebug(params.log, `[${params.account.accountId}] sent relay partial reply snapshot`, {
        senderId: params.senderId,
        sessionKey: outboundMeta.sessionKey,
        sessionId: outboundMeta.sessionId,
        serverPeer: outboundMeta.serverPeer,
        streamId: streamState.streamId,
        streamSeq: streamState.seq,
        textLength: normalized.length,
      });
      touchRuntime(params.account.accountId, {
        lastOutboundAt: Date.now(),
        lastError: null,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      params.log?.error?.(`[${params.account.accountId}] failed to send relay partial reply snapshot: ${message}`, {
        senderId: params.senderId,
        sessionKey: outboundMeta.sessionKey,
        sessionId: outboundMeta.sessionId,
        serverPeer: outboundMeta.serverPeer,
        streamId: streamState.streamId,
        streamSeq: streamState.seq,
        textLength: normalized.length,
      });
      throw err;
    }
  };

  await core.channel.session.recordInboundSession({
    storePath,
    sessionKey: ctxPayload.SessionKey ?? route.sessionKey,
    ctx: ctxPayload,
    onRecordError: () => {},
  });

  if (params.messageId && params.senderId) {
    try {
      await sendProcessedConfirmation({
        account: params.account,
        service: params.service,
        targetPeer: params.senderId,
        targetMessageId: params.messageId,
        sessionKey: params.sessionKey ?? null,
        sessionId: params.sessionId ?? null,
        log: params.log,
      });
    } catch (confirmErr) {
      params.log?.warn?.(`[${params.account.accountId}] failed to send processed confirmation: ${confirmErr instanceof Error ? confirmErr.message : String(confirmErr)}`, {
        senderId: params.senderId,
        messageId: params.messageId,
        sessionKey: params.sessionKey ?? null,
        sessionId: params.sessionId ?? null,
      });
    }
  }

  const { onModelSelected, ...replyPipeline } = createChannelReplyPipeline({
    cfg: params.cfg as any,
    agentId: route.agentId,
    channel: "r2-relay-channel",
    accountId: params.account.accountId,
  });

  await core.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
    ctx: ctxPayload,
    cfg: params.cfg as any,
    dispatcherOptions: {
      ...replyPipeline,
      deliver: async (payload) => {
        const text = normalizeStreamText(payload.text ?? "");
        const mediaUrls = resolveRelayPayloadMediaUrls(payload);
        emitRelayDebug(params.log, `[${params.account.accountId}] relay final payload received`, {
          senderId: params.senderId,
          sessionKey: outboundMeta.sessionKey,
          hasText: Boolean(text.trim()),
          mediaUrl: payload.mediaUrl ?? null,
          mediaUrls,
          rawMediaUrls: payload.mediaUrls ?? null,
          textHasMediaDirective: text.includes("MEDIA:"),
        });
        if (streamState.active && text.trim().length > 0) {
          if (streamState.lastText && !text.startsWith(streamState.lastText)) {
            return;
          }
          streamState.lastText = text;
          streamState.lastEmitAt = Date.now();
        }

        try {
          await sendRelayPayloadMessage({
            cfg: params.cfg as any,
            to: params.senderId,
            payload: {
              ...payload,
              text,
              mediaUrls,
              mediaUrl: mediaUrls[0],
              channelData: payload.channelData ?? null,
            },
            accountId: params.account.accountId,
            log: params.log,
            source: "replyPipeline.final",
            meta: {
              sessionKey: outboundMeta.sessionKey,
              sessionId: outboundMeta.sessionId,
              serverPeer: outboundMeta.serverPeer,
              workspaceDir: resolveAgentWorkspaceDirFromConfig(params.cfg as Record<string, unknown>, route.agentId),
            },
          });
          emitRelayDebug(params.log, `[${params.account.accountId}] sent relay final reply`, {
            senderId: params.senderId,
            sessionKey: outboundMeta.sessionKey,
            sessionId: outboundMeta.sessionId,
            serverPeer: outboundMeta.serverPeer,
            textLength: text.length,
            hasChannelData: Boolean(payload.channelData && Object.keys(payload.channelData).length > 0),
            mediaCount: mediaUrls.length,
          });
          resetStream();
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          params.log?.error?.(`[${params.account.accountId}] failed to send relay final reply: ${message}`, {
            senderId: params.senderId,
            sessionKey: outboundMeta.sessionKey,
            sessionId: outboundMeta.sessionId,
            serverPeer: outboundMeta.serverPeer,
            textLength: text.length,
            hasChannelData: Boolean(payload.channelData && Object.keys(payload.channelData).length > 0),
            mediaCount: mediaUrls.length,
          });
          throw err;
        }
      },
      onError: (err) => {
        throw err instanceof Error ? err : new Error(String(err));
      },
    },
    replyOptions: {
      onModelSelected,
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
    capabilities: ["text", "media", "attachments:v1", "protocol:v1", "session-selection:v1", "server-limits:v1"],
    contact: null,
    last_seen: now,
    sessions,
    agent_capabilities: modelCapabilities ? { models: modelCapabilities } : undefined,
    server_limits: resolvePublishedServerLimits(),
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
        if (!shouldPublishIdentitySession(sessionKey)) {
          continue;
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

function shouldPublishIdentitySession(sessionKey: string): boolean {
  const normalized = sessionKey.trim().toLowerCase();
  if (!normalized) {
    return false;
  }
  if (normalized.startsWith("cron:")) {
    return false;
  }

  const parts = normalized.split(":");
  if (parts.length >= 3 && parts[0] === "agent") {
    const scopedKey = parts.slice(2).join(":");
    if (scopedKey.startsWith("cron:")) {
      return false;
    }
  }

  return true;
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
  log?: RelayPollLog;
}): Promise<void> {
  emitRelayDebug(params.log, `[${params.account.accountId}] sending processed confirmation`, {
    targetPeer: params.targetPeer,
    targetMessageId: params.targetMessageId,
    sessionKey: params.sessionKey ?? null,
    sessionId: params.sessionId ?? null,
    serverPeer: params.account.serverId,
  });
  const result = await params.service.sendMessage(
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
  emitRelayDebug(params.log, `[${params.account.accountId}] processed confirmation sent`, {
    targetPeer: params.targetPeer,
    targetMessageId: params.targetMessageId,
    confirmationKey: result.key,
    confirmationMessageId: result.messageId,
    sessionKey: params.sessionKey ?? null,
    sessionId: params.sessionId ?? null,
  });
}

function formatInboundRelayBody(msg: {
  type?: string;
  body?: string;
  attachments?: { file_name?: string | null; kind?: string | null }[] | null;
  reaction_emoji?: string | null;
  reaction_target_msg_id?: string | null;
  reaction_remove?: boolean | null;
}): string {
  if (msg.type !== "reaction") {
    const body = msg.body?.trim() ?? "";
    if (body) return body;
    // attachment-only message: produce a short description so the agent context is never empty
    const atts = msg.attachments;
    if (atts && atts.length > 0) {
      if (atts.length === 1) {
        const att = atts[0];
        const label = att.file_name ?? (att.kind && att.kind !== "unknown" ? att.kind : "attachment");
        return `[Sent ${label}]`;
      }
      return `[Sent ${atts.length} attachments]`;
    }
    return body;
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

function resolveAgentWorkspaceDirFromConfig(cfg: Record<string, unknown>, agentId?: string | null): string {
  const agents = (cfg.agents ?? {}) as {
    defaults?: { workspace?: string };
    list?: Array<{ id?: string; workspace?: string }>;
  };
  const normalizedAgentId = agentId?.trim() || "main";
  const matched = agents.list?.find((entry) => entry?.id === normalizedAgentId)?.workspace?.trim();
  if (matched) {
    return path.resolve(matched);
  }
  const fallback = agents.defaults?.workspace?.trim();
  if (fallback) {
    return path.resolve(fallback);
  }
  return path.join(os.homedir(), ".openclaw", `workspace${normalizedAgentId === "main" ? "" : `-${normalizedAgentId}`}`);
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

function resolveRelayPayloadMediaUrls(payload: {
  mediaUrl?: string | null;
  mediaUrls?: string[] | null;
}): string[] {
  const urls = [
    ...(payload.mediaUrls ?? []),
    ...(payload.mediaUrl ? [payload.mediaUrl] : []),
  ];
  const seen = new Set<string>();
  return urls
    .map((url) => url?.trim())
    .filter((url): url is string => Boolean(url))
    .filter((url) => {
      if (seen.has(url)) {
        return false;
      }
      seen.add(url);
      return true;
    });
}

async function buildRelayAttachments(params: {
  account: ResolvedR2RelayAccount;
  service: Service;
  targetPeer: string;
  mediaUrls: string[];
  workspaceDir?: string | null;
  log?: RelayPollLog;
  source?: string;
}): Promise<AttachmentRef[]> {
  const attachments: AttachmentRef[] = [];
  if (params.mediaUrls.length === 0) {
    return attachments;
  }

  const relay = params.service.relay;
  const messageId = relay.shortUuid();
  const nowMs = Date.now();
  for (let i = 0; i < params.mediaUrls.length; i++) {
    const url = params.mediaUrls[i];
    const attKey = relay.makeAttKey(params.targetPeer, messageId, i + 1, undefined, nowMs);
    try {
      let buffer: Buffer | null = null;
      let contentType = "application/octet-stream";
      let fileName: string | null = null;

      if (isLocalMediaPath(url)) {
        const workspaceDir = params.workspaceDir?.trim() || process.cwd();
        const resolvedPath = resolveExistingLocalMediaReference(url, workspaceDir);
        const filePath = resolvedPath;
        emitRelayDebug(params.log, `[${params.account.accountId}] resolving local outbound relay media`, {
          source: params.source ?? "unknown",
          rawUrl: url,
          resolvedPath: filePath instanceof URL ? filePath.toString() : filePath,
          workspaceDir,
          cwd: process.cwd(),
        });
        buffer = fs.readFileSync(filePath);
        fileName = path.basename(filePath instanceof URL ? filePath.pathname : filePath);
        contentType = inferContentTypeFromFileName(fileName);
      } else {
        emitRelayDebug(params.log, `[${params.account.accountId}] fetching remote outbound relay media`, {
          source: params.source ?? "unknown",
          mediaUrl: url,
        });
        const resp = await fetch(url);
        if (!resp.ok) {
          params.log?.warn?.(`[${params.account.accountId}] failed to fetch outbound relay media`, {
            source: params.source ?? "unknown",
            mediaUrl: url,
            status: resp.status,
            statusText: resp.statusText,
          });
          continue;
        }
        contentType = resp.headers.get("content-type") || "application/octet-stream";
        buffer = Buffer.from(await resp.arrayBuffer());
        fileName = url.split("/").pop()?.split("?")[0] ?? null;
      }

      const dimensions = inferImageDimensions(buffer, contentType);
      emitRelayDebug(params.log, `[${params.account.accountId}] uploading outbound relay attachment`, {
        source: params.source ?? "unknown",
        attKey,
        fileName,
        contentType,
        size: buffer.length,
        width: dimensions?.width ?? null,
        height: dimensions?.height ?? null,
      });
      await params.service.client.putObject(attKey, buffer, contentType, undefined, undefined, "*");
      attachments.push({
        id: `att-${messageId}-${i + 1}`,
        key: attKey,
        file_name: fileName,
        content_type: contentType,
        size: buffer.length,
        sha256: null,
        kind: inferKindFromMediaType(contentType),
        width: dimensions?.width ?? null,
        height: dimensions?.height ?? null,
        duration_ms: null,
        preview_image_key: null,
        preview_image_type: null,
        preview_size: null,
      });
      emitRelayDebug(params.log, `[${params.account.accountId}] outbound relay attachment uploaded`, {
        source: params.source ?? "unknown",
        attKey,
        fileName,
      });
    } catch (error) {
      params.log?.error?.(`[${params.account.accountId}] failed preparing outbound relay attachment`, {
        source: params.source ?? "unknown",
        mediaUrl: url,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return attachments;
}

async function sendRelayPayloadMessage(params: {
  cfg: Record<string, unknown>;
  to: string;
  payload: {
    text?: string | null;
    mediaUrl?: string | null;
    mediaUrls?: string[] | null;
    channelData?: Record<string, unknown> | null;
  };
  accountId?: string | null;
  log?: RelayPollLog;
  source?: string;
  meta?: {
    sessionKey?: string | null;
    sessionId?: string | null;
    serverPeer?: string | null;
    workspaceDir?: string | null;
  };
}) {
  const account = resolveR2RelayAccount({ cfg: params.cfg, accountId: params.accountId });
  const service = getOrCreateService(account);
  const target = parseRelayTarget(params.to);
  const text = params.payload.text ?? "";
  const mediaUrls = resolveRelayPayloadMediaUrls(params.payload);
  const sessionKey = params.meta?.sessionKey ?? target.sessionKey ?? null;
  const sessionId = params.meta?.sessionId ?? null;
  const serverPeer = params.meta?.serverPeer ?? account.serverId;

  emitRelayDebug(params.log, `[${account.accountId}] outbound relay send starting`, {
    source: params.source ?? "unknown",
    to: params.to,
    peer: target.peer,
    sessionKey,
    mediaCount: mediaUrls.length,
    hasText: Boolean(text.trim()),
  });

  const attachments = await buildRelayAttachments({
    account,
    service,
    targetPeer: target.peer,
    mediaUrls,
    workspaceDir: params.meta?.workspaceDir ?? null,
    log: params.log,
    source: params.source,
  });

  emitRelayDebug(params.log, `[${account.accountId}] sending outbound relay message`, {
    source: params.source ?? "unknown",
    attachmentCount: attachments.length,
    hasText: Boolean(text.trim()),
    targetPeer: target.peer,
    sessionKey,
  });

  const fallbackText = text.trim() || (mediaUrls.length > 0 && attachments.length === 0
    ? mediaUrls.map((url) => `[Attachment unavailable: ${describeLocalMediaReference(url)}]`).join("\n")
    : text);

  const result = await service.sendMessage(target.peer, fallbackText, attachments.length > 0 ? attachments : undefined, {
    sessionKey,
    sessionId,
    serverPeer,
    typeOverride: "text",
    channelData: params.payload.channelData ?? null,
  });
  emitRelayDebug(params.log, `[${account.accountId}] outbound relay message sent`, {
    source: params.source ?? "unknown",
    messageId: result.messageId,
    attachmentCount: attachments.length,
  });

  touchRuntime(account.accountId, {
    lastOutboundAt: Date.now(),
    lastError: null,
  });
  return {
    channel: "r2-relay-channel",
    to: params.to.trim(),
    messageId: result.messageId,
    timestamp: Date.now(),
  };
}

function resolveExistingLocalMediaReference(value: string, workspaceDir: string): string | URL {
  const trimmed = value.trim();
  if (trimmed.toLowerCase().startsWith("file://")) {
    const url = new URL(trimmed);
    return new URL(`file://${resolveExistingFilePrefix(url.pathname)}`);
  }

  const absolute = path.isAbsolute(trimmed)
    ? trimmed
    : path.resolve(workspaceDir, trimmed);
  return resolveExistingFilePrefix(absolute);
}

function resolveExistingFilePrefix(value: string): string {
  const original = value.trim();
  let candidate = original;
  while (candidate.length > 1) {
    try {
      const stat = fs.statSync(candidate);
      if (stat.isFile()) {
        return candidate;
      }
    } catch {
      // keep trimming at whitespace boundaries only
    }

    const next = candidate.replace(/\s+\S+\s*$/, "").trimEnd();
    if (!next || next === candidate) {
      break;
    }
    candidate = next;
  }
  return original;
}

function describeLocalMediaReference(value: string): string {
  const trimmed = value.trim();
  return path.basename(trimmed) || trimmed;
}

function inferImageDimensions(buffer: Buffer, contentType?: string | null): { width: number; height: number } | null {
  const lower = contentType?.toLowerCase() ?? "";
  try {
    if (lower === "image/png" && buffer.length >= 24 && buffer.readUInt32BE(0) === 0x89504e47) {
      return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
    }
    if ((lower === "image/jpeg" || lower === "image/jpg") && buffer.length >= 4 && buffer[0] === 0xff && buffer[1] === 0xd8) {
      let offset = 2;
      while (offset + 9 < buffer.length) {
        if (buffer[offset] !== 0xff) {
          offset += 1;
          continue;
        }
        const marker = buffer[offset + 1];
        const length = buffer.readUInt16BE(offset + 2);
        if (length < 2) {
          break;
        }
        const isStartOfFrame = (marker >= 0xc0 && marker <= 0xc3) || (marker >= 0xc5 && marker <= 0xc7) || (marker >= 0xc9 && marker <= 0xcb) || (marker >= 0xcd && marker <= 0xcf);
        if (isStartOfFrame && offset + 8 < buffer.length) {
          return { width: buffer.readUInt16BE(offset + 7), height: buffer.readUInt16BE(offset + 5) };
        }
        offset += 2 + length;
      }
      return null;
    }
    if (lower === "image/gif" && buffer.length >= 10 && buffer.toString("ascii", 0, 3) === "GIF") {
      return { width: buffer.readUInt16LE(6), height: buffer.readUInt16LE(8) };
    }
    if (lower === "image/webp" && buffer.length >= 30 && buffer.toString("ascii", 0, 4) === "RIFF" && buffer.toString("ascii", 8, 12) === "WEBP") {
      const chunk = buffer.toString("ascii", 12, 16);
      if (chunk === "VP8X" && buffer.length >= 30) {
        return {
          width: 1 + buffer.readUIntLE(24, 3),
          height: 1 + buffer.readUIntLE(27, 3),
        };
      }
      if (chunk === "VP8 " && buffer.length >= 30) {
        return {
          width: buffer.readUInt16LE(26) & 0x3fff,
          height: buffer.readUInt16LE(28) & 0x3fff,
        };
      }
      if (chunk === "VP8L" && buffer.length >= 25) {
        const bits = buffer.readUInt32LE(21);
        return {
          width: (bits & 0x3fff) + 1,
          height: ((bits >> 14) & 0x3fff) + 1,
        };
      }
    }
  } catch {
    return null;
  }
  return null;
}

function inferKindFromMediaType(type?: string | null): AttachmentRef["kind"] {
  if (!type) return "file";
  const lower = type.toLowerCase();
  if (lower.startsWith("image/")) return "image";
  if (lower.startsWith("video/")) return "video";
  if (lower.startsWith("audio/")) return "audio";
  return "file";
}

function isLocalMediaPath(value: string): boolean {
  const lower = value.toLowerCase();
  if (lower.startsWith("http://") || lower.startsWith("https://") || lower.startsWith("data:")) {
    return false;
  }
  if (lower.startsWith("media:")) {
    return false;
  }
  if (lower.startsWith("file://")) {
    return true;
  }
  return path.isAbsolute(value) || value.startsWith("./") || value.startsWith("../");
}

function inferContentTypeFromFileName(fileName?: string | null): string {
  const ext = path.extname(fileName ?? "").toLowerCase();
  switch (ext) {
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".png":
      return "image/png";
    case ".gif":
      return "image/gif";
    case ".webp":
      return "image/webp";
    case ".heic":
      return "image/heic";
    case ".heif":
      return "image/heif";
    case ".mp4":
      return "video/mp4";
    case ".mov":
      return "video/quicktime";
    case ".webm":
      return "video/webm";
    case ".mp3":
      return "audio/mpeg";
    case ".m4a":
      return "audio/mp4";
    case ".wav":
      return "audio/wav";
    case ".ogg":
      return "audio/ogg";
    case ".pdf":
      return "application/pdf";
    case ".txt":
      return "text/plain";
    case ".json":
      return "application/json";
    case ".zip":
      return "application/zip";
    default:
      return "application/octet-stream";
  }
}

function normalizeAttachmentContentType(
  primary?: string | null,
  fallback?: string | null,
  fileName?: string | null,
): string {
  const primaryTrimmed = primary?.trim();
  if (primaryTrimmed) return primaryTrimmed;
  const fallbackTrimmed = fallback?.trim();
  if (fallbackTrimmed) return fallbackTrimmed;
  return inferContentTypeFromFileName(fileName);
}

function classifyInboundRelayMessageFailure(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  if (message.includes("AttachmentTooLarge")) {
    return "attachment_too_large";
  }
  if (message.includes("AttachmentNotFound")) {
    return "attachment_missing";
  }
  return "ingest_error";
}

function resolvePublishedServerLimits(): IdentityServerLimitsDoc {
  return {
    inbound_attachment_max_bytes: {
      image: MAX_IMAGE_BYTES,
      video: MAX_VIDEO_BYTES,
      audio: MAX_AUDIO_BYTES,
      file: MAX_DOCUMENT_BYTES,
    },
    oversize_attachment_behavior: "best_effort_process_then_reply",
  };
}

function resolveInboundAttachmentBestEffortMaxBytes(
  attachment: AttachmentRef,
  defaultMaxBytes: number,
): number {
  if (typeof attachment.size === "number" && Number.isFinite(attachment.size) && attachment.size > 0) {
    return Math.max(defaultMaxBytes, Math.min(attachment.size + 1024 * 1024, 64 * 1024 * 1024));
  }
  return Math.max(defaultMaxBytes, 64 * 1024 * 1024);
}

function isImageAttachment(attachment: AttachmentRef): boolean {
  if (attachment.kind === "image") {
    return true;
  }
  return Boolean(attachment.content_type?.toLowerCase().startsWith("image/"));
}

function isVideoAttachment(attachment: AttachmentRef): boolean {
  if (attachment.kind === "video") {
    return true;
  }
  return Boolean(attachment.content_type?.toLowerCase().startsWith("video/"));
}

function isAudioAttachment(attachment: AttachmentRef): boolean {
  if (attachment.kind === "audio") {
    return true;
  }
  return Boolean(attachment.content_type?.toLowerCase().startsWith("audio/"));
}

function resolveInboundAttachmentMaxBytes(attachment: AttachmentRef): number {
  if (isImageAttachment(attachment)) return MAX_IMAGE_BYTES;
  if (isVideoAttachment(attachment)) return MAX_VIDEO_BYTES;
  if (isAudioAttachment(attachment)) return MAX_AUDIO_BYTES;
  return MAX_DOCUMENT_BYTES;
}

function formatAttachmentContext(attachments?: AttachmentRef[]): string | null {
  if (!attachments || attachments.length === 0) return null;
  const lines = attachments.map((att, i) => {
    const parts: string[] = [`[Attachment ${i + 1}]`];
    if (att.file_name) parts.push(`name: ${att.file_name}`);
    if (att.content_type) parts.push(`type: ${att.content_type}`);
    if (att.kind && att.kind !== "unknown") parts.push(`kind: ${att.kind}`);
    if (att.size) parts.push(`size: ${att.size} bytes`);
    if (att.width && att.height) parts.push(`dimensions: ${att.width}x${att.height}`);
    if (att.duration_ms) parts.push(`duration: ${(att.duration_ms / 1000).toFixed(1)}s`);
    return parts.join(", ");
  });
  return lines.join("\n");
}
