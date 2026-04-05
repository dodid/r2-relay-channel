import { type R2Config } from "./r2client.js";
import { type RelayRetentionConfig, type SweepRuleSummary, Service } from "./service.js";

export class Worker {
  service: Service;
  cfg: R2Config;

  constructor(cfg: R2Config, peerId = "worker") {
    this.service = new Service({
      ...cfg,
      peerId,
    });
    this.cfg = cfg;
  }

  async clearBucket() {
    console.log("Clearing ALL objects in bucket...");
    let cont = true;
    while (cont) {
      const res = await this.service.client.listPrefix("", 1000);
      if (!res || res.length === 0) break;
      for (const obj of res) {
        if (obj?.Key) {
          console.log("Deleting", obj.Key);
          await this.service.client.deleteObject(obj.Key);
        }
      }
      cont = res.length >= 1000;
    }
    console.log("Clear complete.");
  }

  async sweepRetention(ttl: RelayRetentionConfig, abortSignal?: AbortSignal): Promise<SweepRuleSummary[]> {
    return await this.service.sweepRetention(ttl, abortSignal);
  }
}
