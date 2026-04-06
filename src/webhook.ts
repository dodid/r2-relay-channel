import crypto from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { OpenClawConfig } from "openclaw/plugin-sdk/core";
import { resolveR2RelayAccount } from "./config.js";
import { Service } from "./service.js";

const WEBHOOK_BASE_PATH = "/r2-relay-channel/webhook";

type CronWebhookPayload = {
  summary?: unknown;
  text?: unknown;
  error?: unknown;
  jobId?: unknown;
  status?: unknown;
};

export function registerRelayWebhookRoute(api: {
  config: OpenClawConfig;
  logger?: {
    info?: (message: string, meta?: Record<string, unknown>) => void;
    warn?: (message: string, meta?: Record<string, unknown>) => void;
    error?: (message: string, meta?: Record<string, unknown>) => void;
  };
  registerHttpRoute: (route: {
    path: string;
    auth: "plugin" | "gateway";
    match?: "exact" | "prefix";
    handler: (req: IncomingMessage, res: ServerResponse) => Promise<boolean>;
  }) => void;
}): void {
  api.registerHttpRoute({
    path: WEBHOOK_BASE_PATH,
    auth: "plugin",
    match: "prefix",
    handler: async (req, res) => {
      if ((req.method ?? "GET").toUpperCase() !== "POST") {
        respondJson(res, 405, { ok: false, error: "method_not_allowed" });
        return true;
      }

      const expectedToken = readCronWebhookToken(api.config);
      if (!expectedToken) {
        respondJson(res, 503, { ok: false, error: "cron_webhook_token_not_configured" });
        return true;
      }

      const providedToken = readBearerToken(req);
      if (!providedToken || !safeEqual(providedToken, expectedToken)) {
        respondJson(res, 401, { ok: false, error: "unauthorized" });
        return true;
      }

      const target = resolveWebhookTarget(req.url);
      if (!target) {
        respondJson(res, 400, {
          ok: false,
          error: "invalid_target",
          hint: `${WEBHOOK_BASE_PATH}/<peer>/<encoded-session-key>`,
        });
        return true;
      }

      let payload: CronWebhookPayload;
      try {
        payload = parseJsonBody(await readRequestBody(req)) as CronWebhookPayload;
      } catch (err) {
        respondJson(res, 400, {
          ok: false,
          error: "invalid_json",
          detail: err instanceof Error ? err.message : String(err),
        });
        return true;
      }

      const text = extractRelayText(payload);
      if (!text) {
        respondJson(res, 204, null);
        return true;
      }

      try {
        const account = resolveR2RelayAccount({ cfg: api.config });
        if (!account.enabled || !account.configured) {
          respondJson(res, 503, { ok: false, error: "relay_not_configured" });
          return true;
        }

        const service = new Service({
          endpoint: account.endpoint,
          bucket: account.bucket,
          region: account.region,
          accessKeyId: account.accessKeyId,
          secretAccessKey: account.secretAccessKey,
          forcePathStyle: account.forcePathStyle,
          peerId: account.serverId,
        });

        const result = await service.sendMessage(target.to, text, undefined, {
          sessionKey: target.sessionKey,
          sessionId: null,
          serverPeer: account.serverId,
          typeOverride: "text",
        });

        api.logger?.info?.("r2-relay-channel: delivered cron webhook to relay session", {
          to: target.to,
          sessionKey: target.sessionKey,
          jobId: typeof payload.jobId === "string" ? payload.jobId : undefined,
          status: typeof payload.status === "string" ? payload.status : undefined,
          messageId: result.messageId,
        });

        respondJson(res, 200, {
          ok: true,
          to: target.to,
          sessionKey: target.sessionKey,
          messageId: result.messageId,
        });
        return true;
      } catch (err) {
        api.logger?.error?.("r2-relay-channel: cron webhook delivery failed", {
          to: target.to,
          sessionKey: target.sessionKey,
          error: err instanceof Error ? err.message : String(err),
        });
        respondJson(res, 500, {
          ok: false,
          error: "delivery_failed",
          detail: err instanceof Error ? err.message : String(err),
        });
        return true;
      }
    },
  });
}

function readCronWebhookToken(cfg: OpenClawConfig): string | null {
  const token = (cfg as { cron?: { webhookToken?: string } }).cron?.webhookToken;
  return typeof token === "string" && token.trim() ? token.trim() : null;
}

function readBearerToken(req: IncomingMessage): string | null {
  const header = req.headers.authorization;
  if (typeof header !== "string") {
    return null;
  }
  const match = header.match(/^Bearer\s+(.+)$/i);
  const token = match?.[1]?.trim();
  return token || null;
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) {
    return false;
  }
  return crypto.timingSafeEqual(left, right);
}

function resolveWebhookTarget(rawUrl?: string | null): { to: string; sessionKey: string } | null {
  const url = new URL(rawUrl || WEBHOOK_BASE_PATH, "http://localhost");
  const parts = url.pathname
    .split("/")
    .filter(Boolean)
    .map((part) => decodeURIComponent(part));

  if (parts.length < 4 || parts[0] !== "r2-relay-channel" || parts[1] !== "webhook") {
    return null;
  }

  const to = parts[2]?.trim() ?? "";
  const sessionKey = parts.slice(3).join("/").trim();

  if (!to || !sessionKey) {
    return null;
  }

  return { to, sessionKey };
}

async function readRequestBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

function parseJsonBody(raw: string): unknown {
  const text = raw.trim();
  if (!text) {
    throw new Error("request body is empty");
  }
  return JSON.parse(text);
}

function extractRelayText(payload: CronWebhookPayload): string | null {
  const directText = typeof payload.text === "string" ? payload.text.trim() : "";
  if (directText) {
    return directText;
  }

  const summary = typeof payload.summary === "string" ? payload.summary.trim() : "";
  if (summary) {
    return summary;
  }

  const error = typeof payload.error === "string" ? payload.error.trim() : "";
  if (error) {
    return error;
  }

  return null;
}

function respondJson(res: ServerResponse, statusCode: number, body: unknown): void {
  res.statusCode = statusCode;
  if (statusCode === 204) {
    res.end();
    return;
  }
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

export { WEBHOOK_BASE_PATH };
