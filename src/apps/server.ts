import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { RELAY_PLUGIN_VERSION, Service } from "../service.js";
import { CHANNEL_ID } from "../config.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function main() {
  const cfgPath = path.join(__dirname, "..", "..", "r2relay.local.json");
  if (!fs.existsSync(cfgPath)) throw new Error("r2relay.local.json not found");
  const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8")).channels[CHANNEL_ID];

  const peerId = cfg.serverId || "gateway";
  const defaultSessionKey = cfg.sessionKey || "agent:main:main";
  const defaultSessionId = cfg.sessionId || null;
  const svc = new Service({
    endpoint: cfg.endpoint,
    bucket: cfg.bucket,
    region: cfg.region,
    accessKeyId: cfg.accessKeyId,
    secretAccessKey: cfg.secretAccessKey,
    forcePathStyle: cfg.forcePathStyle,
    peerId,
  });

  await svc.publishIdentity({
    peer: peerId,
    display_name: cfg.displayName || peerId,
    role: "server",
    plugin_version: RELAY_PLUGIN_VERSION,
    capabilities: ["text", "protocol:v1", "session-selection:v1"],
    contact: null,
    last_seen: Date.now(),
    sessions: [
      {
        session_key: defaultSessionKey,
        session_id: defaultSessionId,
        updated_at: Date.now(),
        chat_type: "direct",
      },
    ],
  });

  svc.pollInbox(
    peerId,
    async (msg) => {
      console.log("[server] received", msg.msg_id, "from", msg.from, "body:", msg.body);
      const body = msg.body ?? "";
      const snapshots = [
        `processing request…\n\n${body}`,
        `processing request…\n\nreceived:\n- ${body}\n\nassembling reply...`,
        `done\n\nreceived:\n- ${body}\n\nresult: processed:${msg.msg_id}`,
      ];
      await svc.sendStreamingSnapshots(msg.from, snapshots, undefined, {
        sessionKey: msg.session_key ?? defaultSessionKey,
        sessionId: msg.session_id ?? defaultSessionId,
        serverPeer: peerId,
      });
    },
    cfg.pollIntervalMs || 5000,
    40000,
  ).catch((err) => console.error(err));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
