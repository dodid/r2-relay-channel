import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { R2Relay } from "./protocol.js";
import { Service } from "./service.js";
import { CHANNEL_ID } from "./config.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export class Cli {
  async run(argv: string[]) {
    const cmd = argv[0] || "help";
    switch (cmd) {
      case "help":
        return this.help();
      case "test":
        return this.test();
      case "clear":
        return this.clear();
      case "send":
        return this.send(argv.slice(1));
      case "identity":
        return this.identity(argv[1]);
      case "start":
        return this.start(argv[1]);
      default:
        console.log(`Unknown command: ${cmd}`);
        return this.help();
    }
  }

  help() {
    console.log(
      "r2-relay-channel\nCommands:\n  help                              Show this message\n  test                              Run a self-check (no network)\n  clear                             Clear msg/ att/ head/ identity/ in R2 (reads r2relay.local.json)\n  send <to> <msg> [--session-key K] Send a message to <to>, optionally targeting a session\n  identity <peerId>                 Fetch and print identity/<peerId>.json\n  cas-experiment [prefix]           Run CAS/precondition experiments against R2\n  start <peerId>                    Start polling inbox for peerId and print messages\n",
    );
  }

  async loadLocalCfg() {
    const cfgPath = path.join(__dirname, "..", "r2relay.local.json");
    if (!fs.existsSync(cfgPath)) throw new Error("r2relay.local.json not found");
    const raw = fs.readFileSync(cfgPath, "utf8");
    return JSON.parse(raw).channels[CHANNEL_ID];
  }

  async test() {
    console.log("Running self-check for r2-relay-channel protocol module...");
    const relay = new R2Relay({ bucket: "chat-relay" });
    const key = relay.makeMsgKey("gateway");
    console.log("Sample message key:", key);
    console.log("Self-check OK (no network performed).");
  }

  async clear() {
    const c = await this.loadLocalCfg();
    const svc = new Service({
      endpoint: c.endpoint,
      bucket: c.bucket,
      region: c.region,
      accessKeyId: c.accessKeyId,
      secretAccessKey: c.secretAccessKey,
      forcePathStyle: c.forcePathStyle,
      peerId: "cli",
    });
    await svc.client.listPrefix("msg/", 1000).then(async (objs) => {
      for (const o of objs) if (o.Key) await svc.client.deleteObject(o.Key);
    });
    await svc.client.listPrefix("att/", 1000).then(async (objs) => {
      for (const o of objs) if (o.Key) await svc.client.deleteObject(o.Key);
    });
    await svc.client.listPrefix("head/", 1000).then(async (objs) => {
      for (const o of objs) if (o.Key) await svc.client.deleteObject(o.Key);
    });
    await svc.client.listPrefix("identity/", 1000).then(async (objs) => {
      for (const o of objs) if (o.Key) await svc.client.deleteObject(o.Key);
    });
    console.log("Clear complete");
  }

  async send(args: string[]) {
    const sessionFlag = args.indexOf("--session-key");
    let sessionKey: string | null = null;
    if (sessionFlag >= 0) {
      sessionKey = args[sessionFlag + 1] || null;
      args = args.slice(0, sessionFlag);
    }
    const [to, ...rest] = args;
    const msgText = rest.join(" ");
    if (!to || !msgText) return this.help();

    const c = await this.loadLocalCfg();
    const svc = new Service({
      endpoint: c.endpoint,
      bucket: c.bucket,
      region: c.region,
      accessKeyId: c.accessKeyId,
      secretAccessKey: c.secretAccessKey,
      forcePathStyle: c.forcePathStyle,
      peerId: c.id || "cli",
    });
    const res = await svc.sendMessage(to, msgText, undefined, undefined, { sessionKey });
    console.log("Sent message key", res.key);
  }

  async identity(peerId?: string) {
    if (!peerId) return this.help();
    const c = await this.loadLocalCfg();
    const svc = new Service({
      endpoint: c.endpoint,
      bucket: c.bucket,
      region: c.region,
      accessKeyId: c.accessKeyId,
      secretAccessKey: c.secretAccessKey,
      forcePathStyle: c.forcePathStyle,
      peerId: c.id || "cli",
    });
    const identity = await svc.getIdentity(peerId);
    if (!identity) {
      console.log(`No identity found for ${peerId}`);
      return;
    }
    console.log(JSON.stringify(identity, null, 2));
  }

  async start(peerId?: string) {
    if (!peerId) return this.help();
    const c = await this.loadLocalCfg();
    const svc = new Service({
      endpoint: c.endpoint,
      bucket: c.bucket,
      region: c.region,
      accessKeyId: c.accessKeyId,
      secretAccessKey: c.secretAccessKey,
      forcePathStyle: c.forcePathStyle,
      peerId,
    });
    console.log("Publishing identity...");
    await svc.publishIdentity();
    console.log("Starting poll loop for", peerId);
    await svc.pollInbox(
      peerId,
      async (msg) => {
        console.log(
          "Received message:",
          msg.msg_id,
          "from",
          msg.from,
          "ts",
          msg.ts_sent,
          "session_key",
          msg.session_key,
          "body",
          msg.body,
        );
      },
      c.pollIntervalMs || 5000,
      40000,
    );
  }
}
