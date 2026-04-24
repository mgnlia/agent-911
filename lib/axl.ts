/**
 * Thin AXL client. Each AXL node exposes an HTTP API on `localhost:<api_port>`:
 *
 *   GET  /topology  →  JSON { our_public_key, peers[], tree[] }
 *   POST /send      →  raw body; header X-Destination-Peer-Id: <hex pubkey>
 *                     response sets X-Sent-Bytes on success
 *   GET  /recv      →  raw body; header X-From-Peer-Id: <hex pubkey>
 *                     204 No Content when inbox empty
 *
 * Note: /recv returns RAW BINARY (not JSON). The sender peer ID lives in a
 * response header. Length of the body = actual message size.
 *
 * Also: AXL has stream handlers (MCP, A2A) that inspect inbound traffic.
 * If a message looks like JSON-RPC, the A2A stream may claim it and it
 * won't hit the /recv queue. For our attestation traffic we use a short
 * magic prefix + protobuf-ish framing to avoid the JSON-RPC filter. For
 * convenience we also expose sendJson/recvJson which prefix a non-RPC byte.
 */

const MAGIC_PREFIX = Uint8Array.from([0x91, 0x1a, 0x00]); // A911A00 → "Agent-911 Attestation"

export interface Topology {
  our_public_key: string;
  our_ipv6: string;
  peers: unknown[];
  tree: unknown[];
}

export interface RecvRaw {
  fromPeerId: string;
  data: Uint8Array;
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
      // The Node fetch doesn't accept Uint8Array directly in types; wrap in Buffer
      // Uint8Array is a valid BodyInit at runtime though
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      body: data as any,
    });
    if (!r.ok) {
      const body = await r.text();
      throw new Error(`/send failed: ${r.status} ${body}`);
    }
  }

  /** Poll the inbox. Returns null if empty (HTTP 204). */
  async recv(): Promise<RecvRaw | null> {
    const r = await this._fetch("/recv");
    if (r.status === 204) return null;
    if (!r.ok) throw new Error(`/recv failed: ${r.status}`);
    const fromPeerId = r.headers.get("x-from-peer-id") ?? r.headers.get("X-From-Peer-Id") ?? "";
    if (!fromPeerId) return null;
    const buf = new Uint8Array(await r.arrayBuffer());
    return { fromPeerId, data: buf };
  }

  /** JSON-tagged message. Wire format: [MAGIC_PREFIX][utf8 json]. */
  async sendJson(destinationPeerId: string, payload: unknown): Promise<void> {
    const json = new TextEncoder().encode(JSON.stringify(payload));
    const framed = new Uint8Array(MAGIC_PREFIX.length + json.length);
    framed.set(MAGIC_PREFIX, 0);
    framed.set(json, MAGIC_PREFIX.length);
    await this.send(destinationPeerId, framed);
  }

  async recvJson<T = unknown>(): Promise<{ fromPeerId: string; payload: T } | null> {
    const msg = await this.recv();
    if (!msg) return null;
    // Check magic prefix
    if (msg.data.length < MAGIC_PREFIX.length) return null;
    for (let i = 0; i < MAGIC_PREFIX.length; i++) {
      if (msg.data[i] !== MAGIC_PREFIX[i]) {
        // Unknown format — surface the raw peer anyway
        return null;
      }
    }
    const json = new TextDecoder().decode(msg.data.subarray(MAGIC_PREFIX.length));
    return { fromPeerId: msg.fromPeerId, payload: JSON.parse(json) as T };
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
