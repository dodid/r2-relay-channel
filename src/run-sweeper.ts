import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "./worker.js";
import {
  CHANNEL_ID,
  DEFAULT_HEAD_TTL_DAYS,
  DEFAULT_IDENTITY_TTL_DAYS,
  DEFAULT_TTL_DAYS,
} from "./config.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function main() {
  const cfgPath = path.join(__dirname, "..", "r2relay.local.json");
  if (!fs.existsSync(cfgPath)) {
    console.error("Config file not found:", cfgPath);
    process.exit(1);
  }

  const raw = fs.readFileSync(cfgPath, "utf8");
  const cfg = JSON.parse(raw);
  const c = cfg.channels[CHANNEL_ID];
  if (!c) {
    throw new Error(`Channel config '${CHANNEL_ID}' not found in ${cfgPath}`);
  }

  const ttl = {
    msg: c.ttl?.msg ?? c.defaultTtlDays ?? DEFAULT_TTL_DAYS,
    att: c.ttl?.att ?? c.defaultTtlDays ?? DEFAULT_TTL_DAYS,
    identity: c.ttl?.identity ?? DEFAULT_IDENTITY_TTL_DAYS,
    head: c.ttl?.head ?? DEFAULT_HEAD_TTL_DAYS,
  };

  const worker = new Worker({
    endpoint: c.endpoint,
    bucket: c.bucket,
    region: c.region,
    accessKeyId: c.accessKeyId,
    secretAccessKey: c.secretAccessKey,
    forcePathStyle: c.forcePathStyle,
  }, c.serverId || "sweeper");

  const summaries = await worker.sweepRetention(ttl);
  if (summaries.length === 0) {
    console.log("Sweeper complete: no enabled retention rules");
    return;
  }

  for (const summary of summaries) {
    console.log(`${summary.prefix} scanned=${summary.scanned} deleted=${summary.deleted}`);
  }
  console.log("Sweeper complete.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
