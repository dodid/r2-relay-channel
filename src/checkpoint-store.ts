import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { DEFAULT_ACCOUNT_ID } from "openclaw/plugin-sdk/account-id";
import { getRelayRuntime } from "./runtime.js";
import { PLUGIN_ID } from "./config.js";

const RECENT_MESSAGE_IDS_LIMIT = 200;

export interface RelayCheckpointState {
  lastHeadKey: string | null;
  recentMessageIds: string[];
  recentObjectKeys: string[];
  lastPollAt: number | null;
  lastInboundAt: number | null;
}

const DEFAULT_STATE: RelayCheckpointState = {
  lastHeadKey: null,
  recentMessageIds: [],
  recentObjectKeys: [],
  lastPollAt: null,
  lastInboundAt: null,
};

function stateFilePath(accountId = DEFAULT_ACCOUNT_ID): string {
  const baseDir = getRelayRuntime().state.resolveStateDir();
  return path.join(baseDir, "plugins", PLUGIN_ID, `${accountId}.json`);
}

export async function loadCheckpointState(accountId = DEFAULT_ACCOUNT_ID): Promise<RelayCheckpointState> {
  const filePath = stateFilePath(accountId);
  try {
    const raw = await fs.readFile(filePath, "utf8");
    const parsed = JSON.parse(raw) as Partial<RelayCheckpointState>;
    return {
      lastHeadKey: typeof parsed.lastHeadKey === "string" ? parsed.lastHeadKey : null,
      recentMessageIds: Array.isArray(parsed.recentMessageIds)
        ? parsed.recentMessageIds.filter((value): value is string => typeof value === "string")
        : [],
      recentObjectKeys: Array.isArray(parsed.recentObjectKeys)
        ? parsed.recentObjectKeys.filter((value): value is string => typeof value === "string")
        : [],
      lastPollAt: typeof parsed.lastPollAt === "number" ? parsed.lastPollAt : null,
      lastInboundAt: typeof parsed.lastInboundAt === "number" ? parsed.lastInboundAt : null,
    };
  } catch {
    return { ...DEFAULT_STATE };
  }
}

export async function saveCheckpointState(
  state: RelayCheckpointState,
  accountId = DEFAULT_ACCOUNT_ID,
): Promise<void> {
  const filePath = stateFilePath(accountId);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const serialized = JSON.stringify(state, null, 2);
  const tempPath = `${filePath}.${createHash("sha1").update(serialized).digest("hex")}.tmp`;
  await fs.writeFile(tempPath, serialized, "utf8");
  await fs.rename(tempPath, filePath);
}

export function rememberMessage(state: RelayCheckpointState, params: { msgId?: string | null; objectKey?: string | null; at?: number; }): RelayCheckpointState {
  const nextMessageIds = params.msgId
    ? [params.msgId, ...state.recentMessageIds.filter((value) => value !== params.msgId)].slice(
        0,
        RECENT_MESSAGE_IDS_LIMIT,
      )
    : state.recentMessageIds;

  const nextObjectKeys = params.objectKey
    ? [params.objectKey, ...state.recentObjectKeys.filter((value) => value !== params.objectKey)].slice(
        0,
        RECENT_MESSAGE_IDS_LIMIT,
      )
    : state.recentObjectKeys;

  return {
    ...state,
    recentMessageIds: nextMessageIds,
    recentObjectKeys: nextObjectKeys,
    lastInboundAt: params.at ?? Date.now(),
  };
}

export function hasSeenMessage(
  state: RelayCheckpointState,
  params: { msgId?: string | null; objectKey?: string | null },
): boolean {
  if (params.msgId && state.recentMessageIds.includes(params.msgId)) {
    return true;
  }
  if (params.objectKey && state.recentObjectKeys.includes(params.objectKey)) {
    return true;
  }
  return false;
}
