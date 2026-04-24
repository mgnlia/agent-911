/**
 * Thin AXL client. Each AXL node exposes an HTTP API on `localhost:<api_port>`:
 *
 *   GET  /topology  →  { our_public_key, peers[], tree[] }
 *   POST /send      →  raw body, header X-Destination-Peer-Id: <hex pubkey>
 *   GET  /recv      →  JSON { from_peer_id, data }  (polls inbox)
 *
 * Agent-911 watchdogs each bind to a different AXL node; attestations are
 * sent from watchdog-N → coordinator via /send. The coordinator polls /recv
 * on its own node and bundles the signatures into confirmFailure().
 */

export interface Topology {
  our_public_key: string;
  our_ipv6: string;
  peers: unknown[];
  tree: unknown[];
}

export interface RecvResult {
  from_peer_id: string | null;
  data: string | null; // base64
}

export interface AxlClientOpts {
  apiUrl: string; // e.g., http://127.0.0.1:9101
  timeoutMs?: number;
}

export class AxlClient {
  constructor(private readonly opts: AxlClientOpts) {}

  async topology(): Promise<Topology> {
    const r = await this._fetch("/topology");
    return (await r.json()) as Topology;
  }

  async myPublicKey(): Promise<string> {
    return (await this.topology()).our_public_key;
  }

  /** Send raw bytes to a peer identified by hex public key. */
  async send(destinationPeerId: string, data: Uint8Array): Promise<void> {
    const r = await this._fetch("/send", {
      method: "POST",
      headers: {
        "Content-Type": "application/octet-stream",
        "X-Destination-Peer-Id": destinationPeerId,
      },
      body: data,
    });
    if (!r.ok) {
      const body = await r.text();
      throw new Error(`/send failed: ${r.status} ${body}`);
    }
  }

  /** Poll the inbox. Returns null if empty. */
  async recv(): Promise<RecvResult | null> {
    const r = await this._fetch("/recv");
    if (r.status === 204 || r.status === 404) return null;
    const body = (await r.json()) as RecvResult;
    if (!body.from_peer_id) return null;
    return body;
  }

  /** JSON-encoded message helper. Wire format is raw bytes, so we utf-8 encode. */
  async sendJson(destinationPeerId: string, payload: unknown): Promise<void> {
    const data = new TextEncoder().encode(JSON.stringify(payload));
    await this.send(destinationPeerId, data);
  }

  async recvJson<T = unknown>(): Promise<{ fromPeerId: string; payload: T } | null> {
    const msg = await this.recv();
    if (!msg || !msg.data) return null;
    const bytes = Buffer.from(msg.data, "base64");
    const payload = JSON.parse(bytes.toString("utf8")) as T;
    return { fromPeerId: msg.from_peer_id!, payload };
  }

  private async _fetch(path: string, init?: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), this.opts.timeoutMs ?? 10_000);
    try {
      return await fetch(`${this.opts.apiUrl}${path}`, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(t);
    }
  }
}
