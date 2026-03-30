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

  const peerId = cfg.clientId || "client-1";
  const serverId = cfg.serverId || "gateway";
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

  let i = 1;
  setInterval(async () => {
    const text = `hello ${i++} from ${peerId} at ${Date.now()}`;
    try {
      const res = await svc.sendMessage(serverId, text);
      console.log("sent", res.key);
    } catch (err) {
      console.error("send failed", err);
    }
  }, 10000);

  svc.pollInbox(
    peerId,
    async (msg) => {
      console.log(
        "[client] received message",
        msg.msg_id,
        "from",
        msg.from,
        "body:",
        msg.body,
      );
      await svc.sendMessage(msg.from, `ack:${msg.msg_id}`);
    },
    cfg.pollIntervalMs || 5000,
    40000,
    false,
  ).catch((err) => console.error(err));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
