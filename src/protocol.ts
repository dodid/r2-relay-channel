export interface MessageMeta {
  msg_id: string;
  from: string;
  to: string;
  ts_sent: number;
  prev_key: string | null;
  type?: string;
  body?: string;
  reaction_target_msg_id?: string | null;
  reaction_emoji?: string | null;
  reaction_remove?: boolean | null;
  attachments?: { key: string; size?: number; content_type?: string }[];
  size?: number;
  sig?: string | null;
  session_key?: string | null;
  session_id?: string | null;
  server_peer?: string | null;
  processed_at?: number | null;
  processed_by?: string | null;
  processed_state?: string | null;
  stream_id?: string | null;
  stream_seq?: number | null;
  stream_state?: "partial" | "final" | null;
}

export interface HeadDoc {
  head_key: string;
  head_msg_id: string;
  head_ts: number;
  head_etag?: string;
}

export interface IdentitySessionDoc {
  session_key: string;
  session_id?: string | null;
  updated_at?: number | null;
  chat_type?: string | null;
  channel?: string | null;
  account_id?: string | null;
}

export interface IdentityModelDoc {
  id: string;
  label?: string | null;
  provider?: string | null;
}

export interface IdentityDoc {
  peer: string;
  role: string;
  plugin_version?: string | null;
  capabilities: string[];
  contact: string | null;
  last_seen: number;
  display_name?: string | null;
  sessions?: IdentitySessionDoc[];
  agent_capabilities?: {
    models?: {
      available: IdentityModelDoc[];
      default?: string | null;
    };
  };
}

export interface R2RelayOptions {
  bucket: string;
}

const MAX_MS = 9999999999999;

export class R2Relay {
  opts: R2RelayOptions;

  constructor(opts: R2RelayOptions) {
    this.opts = opts;
  }

  padRevTs(ts: number) {
    const rev = MAX_MS - ts;
    return String(rev).padStart(13, "0");
  }

  shortUuid() {
    return Math.random().toString(16).slice(2, 10);
  }

  makeMsgKey(recipient: string, nowMs?: number) {
    const ts = nowMs ?? Date.now();
    return `msg/${recipient}/${this.padRevTs(ts)}-${this.shortUuid()}.json`;
  }

  makeAttKey(recipient: string, name?: string) {
    const id = this.shortUuid();
    const safeName = name ? `-${name.replace(/[^a-zA-Z0-9._-]/g, "")}` : "";
    return `att/${recipient}/${id}${safeName}`;
  }

  makeHeadKey(recipient: string) {
    return `head/${recipient}.json`;
  }

  makeIdentityKey(peer: string) {
    return `identity/${peer}.json`;
  }

  makeIdentifyKey(peer: string) {
    return this.makeIdentityKey(peer);
  }
}
