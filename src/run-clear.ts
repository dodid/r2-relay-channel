import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "./worker.js";
import { CHANNEL_ID } from "./config.js";

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
  const worker = new Worker({
    endpoint: c.endpoint,
    bucket: c.bucket,
    region: c.region,
    accessKeyId: c.accessKeyId,
    secretAccessKey: c.secretAccessKey,
    forcePathStyle: c.forcePathStyle,
  });

  const prompt = process.argv.includes("--yes")
    ? "yes"
    : await askConfirm(`This will DELETE ALL OBJECTS in bucket '${c.bucket}'. Type 'yes' to proceed: `);
  if (prompt !== "yes") {
    console.log("Aborted. No objects were deleted.");
    process.exit(0);
  }

  await worker.clearBucket();
}

async function askConfirm(question: string): Promise<string> {
  return new Promise((resolve) => {
    process.stdout.write(question);
    process.stdin.setEncoding("utf8");
    process.stdin.once("data", (data) => {
      resolve(String(data).trim());
    });
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
