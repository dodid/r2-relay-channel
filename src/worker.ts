import { R2Client, type R2Config } from "./r2client.js";
import { R2Relay } from "./protocol.js";

export class Worker {
  client: R2Client;
  cfg: R2Config;
  relay: R2Relay;

  constructor(cfg: R2Config) {
    this.client = new R2Client(cfg);
    this.cfg = cfg;
    this.relay = new R2Relay({ bucket: cfg.bucket });
  }

  async clearBucket() {
    console.log("Clearing ALL objects in bucket...");
    let cont = true;
    while (cont) {
      const res = await this.client.listPrefix("", 1000);
      if (!res || res.length === 0) break;
      for (const obj of res) {
        if (obj?.Key) {
          console.log("Deleting", obj.Key);
          await this.client.deleteObject(obj.Key);
        }
      }
      cont = res.length >= 1000;
    }
    console.log("Clear complete.");
  }
}
