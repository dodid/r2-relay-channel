import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { R2Client } from "./r2client.js";
import { HeadDoc, IdentityDoc, MessageMeta, R2Relay } from "./protocol.js";

export const IDENTITY_REFRESH_INTERVAL_MS = 12 * 60 * 60 * 1000;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function resolvePluginVersion(): string {
  try {
    const pkgPath = path.join(__dirname, "..", "package.json");
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8")) as { version?: string };
    const version = pkg.version?.trim();
    return version || "0.0.0";
  } catch {
    return "0.0.0";
  }
}

export const RELAY_PLUGIN_VERSION = resolvePluginVersion();

export interface ServiceConfig {
  endpoint: string;
  bucket: string;
  region?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  forcePathStyle?: boolean;
  peerId: string;
}

export interface InboxMessage {
  key: string;
  message: MessageMeta;
}

export interface InboxBatch {
  head: HeadDoc | null;
  messages: InboxMessage[];
}

export interface SendMessageOptions {
  sessionKey?: string | null;
  sessionId?: string | null;
  serverPeer?: string | null;
  streamId?: string | null;
  streamSeq?: number | null;
  streamState?: "partial" | "final" | null;
  typeOverride?: string | null;
  reactionTargetMessageId?: string | null;
  reactionEmoji?: string | null;
  reactionRemove?: boolean | null;
  channelData?: Record<string, unknown> | null;
}

export interface SendMessageResult {
  key: string;
  messageId: string;
}

export interface RelayRetentionConfig {
  msg?: number;
  att?: number;
  identity?: number;
  head?: number;
}

export interface SweepRuleSummary {
  prefix: string;
  scanned: number;
  deleted: number;
}

export class Service {
  client: R2Client;
  relay: R2Relay;
  cfg: ServiceConfig;
  private sendLanes = new Map<string, Promise<SendMessageResult>>();

  constructor(cfg: ServiceConfig) {
    this.cfg = cfg;
    this.client = new R2Client(cfg);
    this.relay = new R2Relay({ bucket: cfg.bucket });
  }

  async publishIdentity(identity?: Partial<IdentityDoc>) {
    const key = this.relay.makeIdentityKey(this.cfg.peerId);
    const doc: IdentityDoc = {
      role: "server",
      plugin_version: RELAY_PLUGIN_VERSION,
      capabilities: ["text", "protocol:v1", "assistant-stream-snapshots:v1"],
      contact: null,
      ...(identity ?? {}),
      peer: identity?.peer ?? this.cfg.peerId,
      last_seen: identity?.last_seen ?? Date.now(),
    };
    await this.client.putObject(key, JSON.stringify(doc), "application/json");
    return doc;
  }

  async publishIdentify(identity?: Partial<IdentityDoc>) {
    return this.publishIdentity(identity);
  }

  async getIdentity(peer: string): Promise<IdentityDoc | null> {
    const key = this.relay.makeIdentityKey(peer);
    try {
      const res = await this.client.getObject(key);
      if (!res?.Body) {
        return null;
      }
      const body = await streamToUtf8(res.Body as unknown);
      return JSON.parse(body) as IdentityDoc;
    } catch {
      return null;
    }
  }

  async sendMessage(
    to: string,
    body: string,
    attachments?: { key: string; size?: number; content_type?: string }[],
    options?: SendMessageOptions,
  ) {
    const previous = this.sendLanes.get(to) ?? Promise.resolve({ key: "", messageId: "" });
    const current = previous
      .catch(() => ({ key: "", messageId: "" }))
      .then(() => this.sendMessageUnlocked(to, body, attachments, options));
    this.sendLanes.set(to, current);
    try {
      return await current;
    } finally {
      if (this.sendLanes.get(to) === current) {
        this.sendLanes.delete(to);
      }
    }
  }

  private async sendMessageUnlocked(
    to: string,
    body: string,
    attachments?: { key: string; size?: number; content_type?: string }[],
    options?: SendMessageOptions,
  ) {
    const now = Date.now();
    const hasStream = Boolean(options?.streamId);
    const headKey = this.relay.makeHeadKey(to);
    const maxRetries = 8;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      const currentHead = await this.getHeadState(to);
      const prevKey = currentHead?.doc.head_key ?? null;
      const key = this.relay.makeMsgKey(to, Date.now());
      const msg: MessageMeta = {
        msg_id: this.relay.shortUuid(),
        from: this.cfg.peerId,
        to,
        ts_sent: now,
        prev_key: prevKey,
        type: options?.typeOverride ?? (hasStream ? "assistant_stream" : attachments && attachments.length ? "attachment" : "text"),
        body,
        attachments: attachments || [],
        size: body ? Buffer.byteLength(body) : 0,
        sig: null,
        session_key: options?.sessionKey ?? null,
        session_id: options?.sessionId ?? null,
        server_peer: options?.serverPeer ?? null,
        stream_id: options?.streamId ?? null,
        stream_seq: options?.streamSeq ?? null,
        stream_state: options?.streamState ?? null,
        reaction_target_msg_id: options?.reactionTargetMessageId ?? null,
        reaction_emoji: options?.reactionEmoji ?? null,
        reaction_remove: options?.reactionRemove ?? null,
        channel_data: options?.channelData ?? null,
      };
      const newHead: HeadDoc = {
        head_key: key,
        head_msg_id: msg.msg_id,
        head_ts: Date.now(),
        head_etag: undefined,
      };

      await this.client.putObject(key, JSON.stringify(msg), "application/json", undefined, undefined, "*");

      try {
        if (!currentHead?.doc) {
          await this.client.putObject(headKey, JSON.stringify(newHead), "application/json", undefined, undefined, "*");
        } else {
          if (!currentHead.etag) {
            throw new Error("Missing head ETag for CAS update");
          }
          await this.client.putObject(headKey, JSON.stringify(newHead), "application/json", undefined, currentHead.etag, undefined);
        }
        return { key, messageId: msg.msg_id };
      } catch (err: unknown) {
        if (!isPreconditionFailure(err)) {
          throw err;
        }
        await sleep(20 + Math.random() * 80);
      }
    }

    throw new Error("Failed to append message after CAS retries");
  }

  async sendStreamingSnapshots(
    to: string,
    snapshots: string[],
    options?: Omit<SendMessageOptions, "streamSeq" | "streamState">,
  ) {
    const streamId = options?.streamId ?? this.relay.shortUuid();
    const results: SendMessageResult[] = [];

    for (let index = 0; index < snapshots.length; index++) {
      const body = snapshots[index] ?? "";
      if (!body.trim()) {
        continue;
      }
      const isFinal = index === snapshots.length - 1;
      const result = await this.sendMessage(to, body, undefined, {
        ...options,
        streamId,
        streamSeq: index + 1,
        streamState: isFinal ? "final" : "partial",
        typeOverride: "assistant_stream",
      });
      results.push(result);
    }

    return { streamId, results };
  }

  async getHead(peer: string): Promise<HeadDoc | null> {
    return (await this.getHeadState(peer))?.doc ?? null;
  }

  async getHeadState(peer: string): Promise<{ doc: HeadDoc; etag: string | null } | null> {
    const key = this.relay.makeHeadKey(peer);
    try {
      const res = await this.client.getJsonWithEtag<HeadDoc>(key);
      return res ? { doc: res.body, etag: res.etag } : null;
    } catch {
      return null;
    }
  }

  async readMessage(key: string): Promise<MessageMeta | null> {
    const res = await this.client.getObject(key);
    if (!res?.Body) {
      return null;
    }
    const body = await streamToUtf8(res.Body as unknown);
    return JSON.parse(body) as MessageMeta;
  }

  async markMessageProcessed(
    key: string,
    patch: {
      processedAt?: number;
      processedBy?: string | null;
      processedState?: string | null;
    },
  ): Promise<MessageMeta | null> {
    const msg = await this.readMessage(key);
    if (!msg) {
      return null;
    }
    const updated: MessageMeta = {
      ...msg,
      processed_at: patch.processedAt ?? Date.now(),
      processed_by: patch.processedBy ?? this.cfg.peerId,
      processed_state: patch.processedState ?? msg.processed_state ?? "processed",
    };
    await this.client.putObject(key, JSON.stringify(updated), "application/json");
    return updated;
  }

  async collectInboxMessages(selfId: string, lastSeenKey: string | null): Promise<InboxBatch> {
    const head = await this.getHead(selfId);
    if (!head?.head_key || head.head_key === lastSeenKey) {
      return { head, messages: [] };
    }

    let current: string | null = head.head_key;
    const toProcess: InboxMessage[] = [];
    const visitedKeys = new Set<string>();
    const MAX_CHAIN_DEPTH = 500;

    while (current && current !== lastSeenKey) {
      if (visitedKeys.has(current) || toProcess.length >= MAX_CHAIN_DEPTH) {
        break;
      }
      visitedKeys.add(current);
      const msg = await this.readMessage(current);
      if (!msg) {
        break;
      }
      toProcess.push({ key: current, message: msg });
      current = msg.prev_key || null;
    }

    toProcess.reverse();
    return { head, messages: toProcess };
  }

  async sweepByKeyTimestamp(prefix: string, ttlDays: number, abortSignal?: AbortSignal): Promise<SweepRuleSummary> {
    const cutoffTs = Date.now() - ttlDays * 24 * 60 * 60 * 1000;
    let continuationToken: string | undefined;
    let scanned = 0;
    let deleted = 0;

    while (!abortSignal?.aborted) {
      const page = await this.client.listPrefixPage(prefix, continuationToken, 1000);
      const toDelete: string[] = [];

      for (const item of page.contents) {
        const key = item.Key;
        if (!key) continue;
        scanned += 1;
        const ts = extractTimestampFromRelayKey(key);
        if (ts !== null && ts < cutoffTs) {
          toDelete.push(key);
        }
      }

      for (let i = 0; i < toDelete.length; i += 500) {
        const chunk = toDelete.slice(i, i + 500);
        await this.client.deleteObjects(chunk);
        deleted += chunk.length;
      }

      if (!page.isTruncated || !page.nextContinuationToken) {
        break;
      }
      continuationToken = page.nextContinuationToken;
    }

    return { prefix, scanned, deleted };
  }

  async sweepByLastModified(prefix: string, ttlDays: number, abortSignal?: AbortSignal): Promise<SweepRuleSummary> {
    const cutoffTs = Date.now() - ttlDays * 24 * 60 * 60 * 1000;
    let continuationToken: string | undefined;
    let scanned = 0;
    let deleted = 0;

    while (!abortSignal?.aborted) {
      const page = await this.client.listPrefixPage(prefix, continuationToken, 1000);
      const toDelete: string[] = [];

      for (const item of page.contents) {
        const key = item.Key;
        if (!key) continue;
        scanned += 1;
        const lastModified = item.LastModified?.getTime?.() ?? null;
        if (lastModified !== null && lastModified < cutoffTs) {
          toDelete.push(key);
        }
      }

      for (let i = 0; i < toDelete.length; i += 500) {
        const chunk = toDelete.slice(i, i + 500);
        await this.client.deleteObjects(chunk);
        deleted += chunk.length;
      }

      if (!page.isTruncated || !page.nextContinuationToken) {
        break;
      }
      continuationToken = page.nextContinuationToken;
    }

    return { prefix, scanned, deleted };
  }

  async sweepRetention(ttl: RelayRetentionConfig, abortSignal?: AbortSignal): Promise<SweepRuleSummary[]> {
    const summaries: SweepRuleSummary[] = [];

    if ((ttl.msg ?? 0) > 0) {
      summaries.push(await this.sweepByKeyTimestamp("msg/", ttl.msg as number, abortSignal));
    }
    if ((ttl.att ?? 0) > 0) {
      summaries.push(await this.sweepByKeyTimestamp("att/", ttl.att as number, abortSignal));
    }
    if ((ttl.identity ?? 0) > 0) {
      summaries.push(await this.sweepByLastModified("identity/", ttl.identity as number, abortSignal));
    }
    if ((ttl.head ?? 0) > 0) {
      summaries.push(await this.sweepByLastModified("head/", ttl.head as number, abortSignal));
    }

    return summaries;
  }

  async pollInbox(
    selfId: string,
    handler: (msg: MessageMeta, key: string) => Promise<void>,
    pollIntervalMs = 5000,
    backoffMax = 40000,
    deleteAfterProcessing = true,
    abortSignal?: AbortSignal,
  ) {
    let interval = pollIntervalMs;
    let lastSeenKey: string | null = null;

    while (!abortSignal?.aborted) {
      try {
        const batch = await this.collectInboxMessages(selfId, lastSeenKey);
        if (batch.messages.length > 0) {
          for (const item of batch.messages) {
            await handler(item.message, item.key);
            if (deleteAfterProcessing) {
              await this.client.deleteObject(item.key);
            }
          }
          lastSeenKey = batch.head?.head_key ?? lastSeenKey;
          interval = pollIntervalMs;
        }

        await sleep(interval, abortSignal);
        if (!batch.head?.head_key) {
          interval = Math.min(interval * 2, backoffMax);
        }
      } catch (err) {
        if (abortSignal?.aborted) {
          break;
        }
        console.error("Poll error", err);
        await sleep(interval, abortSignal);
        interval = Math.min(interval * 2, backoffMax);
      }
    }
  }
}

function isPreconditionFailure(err: unknown): boolean {
  const value = err as { code?: string } | null;
  return value?.code === "PreconditionFailed";
}

function extractTimestampFromRelayKey(key: string): number | null {
  const name = key.split("/").pop()?.trim() ?? "";
  const match = name.match(/^(\d{13})-/);
  if (!match) {
    return null;
  }
  const reversed = Number(match[1]);
  if (!Number.isFinite(reversed)) {
    return null;
  }
  const ts = 9999999999999 - reversed;
  return Number.isFinite(ts) ? ts : null;
}

async function streamToUtf8(stream: unknown): Promise<string> {
  if (typeof stream === "string") {
    return stream;
  }
  if (!stream) {
    return "";
  }

  const body = stream as {
    transformToString?: () => Promise<string>;
    [Symbol.asyncIterator]?: () => AsyncIterator<unknown>;
  };

  if (typeof body.transformToString === "function") {
    return await body.transformToString();
  }

  if (typeof body[Symbol.asyncIterator] === "function") {
    const chunks: Buffer[] = [];
    for await (const chunk of body as AsyncIterable<unknown>) {
      chunks.push(Buffer.from(chunk as Uint8Array));
    }
    return Buffer.concat(chunks).toString("utf8");
  }

  return String(stream);
}

async function sleep(ms: number, abortSignal?: AbortSignal): Promise<void> {
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    if (!abortSignal) {
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    if (abortSignal.aborted) {
      onAbort();
      return;
    }
    abortSignal.addEventListener("abort", onAbort, { once: true });
  });
}
