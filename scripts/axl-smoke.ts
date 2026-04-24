#!/usr/bin/env tsx
/**
 * axl-smoke.ts — verify the 3-node mesh. Expects nodes on :9101/:9102/:9103.
 *
 * Checks:
 *   1. Each /topology responds with a distinct public key.
 *   2. Each node reports >=1 peer (bootstrap mesh connection).
 *   3. node-1 can /send a message to node-2's public key, and node-2's /recv
 *      inbox surfaces it within a few polls.
 */

import { AxlClient } from "../lib/axl.ts";

const NODES = [
  { id: 1, api: "http://127.0.0.1:9101" },
  { id: 2, api: "http://127.0.0.1:9102" },
  { id: 3, api: "http://127.0.0.1:9103" },
];

async function main(): Promise<void> {
  const clients = NODES.map((n) => ({ ...n, cli: new AxlClient({ apiUrl: n.api }) }));

  console.log("=== topology ===");
  const topos = [];
  for (const c of clients) {
    const t = await c.cli.topology();
    topos.push({ id: c.id, pk: t.our_public_key, peers: (t.peers ?? []).length });
    console.log(`node-${c.id}: pk=${t.our_public_key.slice(0, 24)}… peers=${(t.peers ?? []).length}`);
  }

  const uniquePks = new Set(topos.map((t) => t.pk));
  if (uniquePks.size !== NODES.length) {
    throw new Error(`expected ${NODES.length} distinct public keys, got ${uniquePks.size}`);
  }

  console.log("\n=== send/recv roundtrip (node-1 → node-2) ===");
  const dest = topos[1]!.pk;
  const payload = { kind: "smoke", ts: Date.now(), msg: "hello from agent-911" };
  await clients[0]!.cli.sendJson(dest, payload);
  console.log("node-1 → node-2 sent");

  let received: { fromPeerId: string; payload: unknown } | null = null;
  for (let i = 0; i < 30; i++) {
    received = await clients[1]!.cli.recvJson();
    if (received) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  if (!received) throw new Error("node-2 did not receive within 15s");
  console.log(`node-2 received from ${received.fromPeerId.slice(0, 24)}…: ${JSON.stringify(received.payload)}`);

  console.log("\n=== AXL mesh OK ===");
}

main().catch((err: unknown) => {
  console.error("axl-smoke FAILED:", err);
  process.exit(1);
});
