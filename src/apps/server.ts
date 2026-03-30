import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Service } from "../service.js";
import { CHANNEL_ID } from "../config.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function main() {
  const cfgPath = path.join(__dirname, "..", "..", "r2relay.local.json");
  if (!fs.existsSync(cfgPath)) throw new Error("r2relay.local.json not found");
  const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8")).channels[CHANNEL_ID];

  const peerId = cfg.serverId || "gateway";
  const svc = new Service({
    endpoint: cfg.endpoint,
    bucket: cfg.bucket,
    region: cfg.region,
    accessKeyId: cfg.accessKeyId,
    secretAccessKey: cfg.secretAccessKey,
    forcePathStyle: cfg.forcePathStyle,
    peerId,
  });

  await svc.publishIdentity();

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
        sessionKey: msg.session_key ?? null,
        sessionId: msg.session_id ?? null,
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
