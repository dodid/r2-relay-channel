import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { R2Relay } from "./protocol.js";
import { Service } from "./service.js";
import {
  CHANNEL_ID,
  DEFAULT_HEAD_TTL_DAYS,
  DEFAULT_IDENTITY_TTL_DAYS,
  DEFAULT_TTL_DAYS,
} from "./config.js";

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
      case "sweep":
        return this.sweep();
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
      "r2-relay-channel\nCommands:\n  help                              Show this message\n  test                              Run a self-check (no network)\n  clear                             Clear msg/ att/ head/ identity/ in R2 (reads r2relay.local.json)\n  sweep                             Run one retention sweep pass (reads r2relay.local.json)\n  send <to> <msg> [--session-key K] Send a message to <to>, optionally targeting a session\n  identity <peerId>                 Fetch and print identity/<peerId>.json\n  start <peerId>                    Start polling inbox for peerId and print messages\n",
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

    let totalDeleted = 0;
    const clearPrefix = async (prefix: string) => {
      while (true) {
        const objs = await svc.client.listPrefix(prefix, 1000);
        if (!objs.length) {
          return;
        }
        for (const o of objs) {
          if (!o.Key) continue;
          await svc.client.deleteObject(o.Key);
          totalDeleted += 1;
        }
        if (objs.length < 1000) {
          return;
        }
      }
    };

    await clearPrefix("msg/");
    await clearPrefix("att/");
    await clearPrefix("head/");
    await clearPrefix("identity/");
    console.log(`Clear complete (${totalDeleted} objects deleted)`);
  }

  async sweep() {
    const c = await this.loadLocalCfg();
    const svc = new Service({
      endpoint: c.endpoint,
      bucket: c.bucket,
      region: c.region,
      accessKeyId: c.accessKeyId,
      secretAccessKey: c.secretAccessKey,
      forcePathStyle: c.forcePathStyle,
      peerId: c.serverId || "cli-sweeper",
    });

    const summaries = await svc.sweepRetention({
      msg: c.ttl?.msg ?? c.defaultTtlDays ?? DEFAULT_TTL_DAYS,
      att: c.ttl?.att ?? c.defaultTtlDays ?? DEFAULT_TTL_DAYS,
      identity: c.ttl?.identity ?? DEFAULT_IDENTITY_TTL_DAYS,
      head: c.ttl?.head ?? DEFAULT_HEAD_TTL_DAYS,
    });

    if (!summaries.length) {
      console.log("Sweep complete: no enabled retention rules");
      return;
    }

    for (const summary of summaries) {
      console.log(`${summary.prefix} scanned=${summary.scanned} deleted=${summary.deleted}`);
    }
    console.log("Sweep complete.");
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
    const res = await svc.sendMessage(to, msgText, undefined, { sessionKey });
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
