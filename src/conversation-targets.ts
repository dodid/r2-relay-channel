import fs from "node:fs";
import path from "node:path";
import type { PluginCommandContext } from "openclaw/plugin-sdk/core";
import { resolvePluginStateDir } from "./runtime.js";

const STORE_FILE = "conversation-targets.json";

export interface ConversationTargetRecord {
  channel: string;
  accountId: string;
  conversationId: string;
  threadId?: string | number | null;
  peer: string;
  sessionKey: string;
  updatedAt: number;
}

type ConversationTargetStore = Record<string, ConversationTargetRecord>;

export function rememberConversationTarget(params: {
  channel: string;
  accountId: string;
  conversationId: string;
  threadId?: string | number | null;
  peer: string;
  sessionKey: string;
}): void {
  const store = loadStore();
  const key = buildStoreKey({
    channel: params.channel,
    accountId: params.accountId,
    conversationId: params.conversationId,
    threadId: params.threadId,
  });

  store[key] = {
    channel: params.channel,
    accountId: params.accountId,
    conversationId: params.conversationId,
    threadId: params.threadId ?? null,
    peer: params.peer,
    sessionKey: params.sessionKey,
    updatedAt: Date.now(),
  };

  saveStore(store);
}

export function resolveCommandConversationTarget(ctx: PluginCommandContext): ConversationTargetRecord | null {
  const store = loadStore();
  const conversationId = resolveCanonicalCommandConversationId(ctx);
  if (!conversationId) {
    return null;
  }

  const directKey = buildStoreKey({
    channel: ctx.channel,
    accountId: ctx.accountId,
    conversationId,
    threadId: ctx.messageThreadId,
  });
  const fallbackKey = buildStoreKey({
    channel: ctx.channel,
    accountId: ctx.accountId,
    conversationId,
    threadId: null,
  });

  return store[directKey] ?? store[fallbackKey] ?? null;
}

export function buildCronTarget(peer: string, sessionKey: string): string {
  return `peer=${peer},session=${sessionKey}`;
}

export function buildWebhookPath(peer: string, sessionKey: string): string {
  return `/r2-relay-channel/webhook/${encodeURIComponent(peer)}/${encodeURIComponent(sessionKey)}`;
}

export function buildWebhookUrl(cfg: { gateway?: { publicBaseUrl?: string | null; externalUrl?: string | null; bindUrl?: string | null; port?: number | null; remote?: { url?: string | null } | null } }, peer: string, sessionKey: string): string | null {
  const pathPart = buildWebhookPath(peer, sessionKey);
  const localBase = resolveLocalGatewayBaseUrl(cfg);
  const base =
    localBase ||
    cfg.gateway?.publicBaseUrl?.trim() ||
    cfg.gateway?.externalUrl?.trim() ||
    cfg.gateway?.remote?.url?.trim() ||
    cfg.gateway?.bindUrl?.trim() ||
    "";

  if (!base) {
    return null;
  }

  try {
    const normalizedBase = normalizeWebhookBaseUrl(base);
    return new URL(pathPart, ensureTrailingSlash(normalizedBase)).toString();
  } catch {
    return null;
  }
}

function ensureTrailingSlash(value: string): string {
  return value.endsWith("/") ? value : `${value}/`;
}

function resolveLocalGatewayBaseUrl(cfg: { gateway?: { port?: number | null } }): string | null {
  const port = cfg.gateway?.port;
  if (typeof port === "number" && Number.isFinite(port) && port > 0) {
    return `http://127.0.0.1:${port}`;
  }
  return null;
}

function normalizeWebhookBaseUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol === "ws:") {
    url.protocol = "http:";
  } else if (url.protocol === "wss:") {
    url.protocol = "https:";
  }
  return url.toString();
}

function resolveCanonicalCommandConversationId(ctx: PluginCommandContext): string | null {
  const from = ctx.from?.trim();
  return from || null;
}

function buildStoreKey(params: {
  channel: string;
  accountId?: string | null;
  conversationId: string;
  threadId?: string | number | null;
}): string {
  return [
    params.channel,
    params.accountId?.trim() || "default",
    params.conversationId,
    params.threadId == null ? "-" : String(params.threadId),
  ].join("::");
}


function loadStore(): ConversationTargetStore {
  const file = resolveStoreFile();
  try {
    const raw = fs.readFileSync(file, "utf8");
    const parsed = JSON.parse(raw) as ConversationTargetStore;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function saveStore(store: ConversationTargetStore): void {
  const file = resolveStoreFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(store, null, 2)}\n`, "utf8");
}

function resolveStoreFile(): string {
  return path.join(resolvePluginStateDir(), STORE_FILE);
}
