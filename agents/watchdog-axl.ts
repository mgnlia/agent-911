#!/usr/bin/env tsx
/**
 * watchdog-axl.ts — same failure observation as agents/watchdog.ts, but
 * publishes the signed attestation via AXL /send to a coordinator peer
 * instead of dropping to a shared directory.
 *
 * Intended to run on its own AXL node (distinct api_port + distinct keys).
 */

import { parseArgs } from "node:util";
import { heartbeatAgeMs } from "../lib/heartbeat-bus.ts";
import { signAttestation } from "../lib/eip712.ts";
import { AxlClient } from "../lib/axl.ts";

interface Args {
  watchdogId: string;
  privateKey: string;
  heartbeatPath: string;
  policyId: `0x${string}`;
  runbookHash: `0x${string}`;
  verifyingContract: `0x${string}`;
  chainId: number;
  pollMs: number;
  thresholdMs: number;
  expirySeconds: number;
  axlApiUrl: string;        // my own AXL node
  coordinatorPeerId: string; // where to send attestations
}

function parse(): Args {
  const { values } = parseArgs({
    options: {
      "watchdog-id":         { type: "string", default: "watchdog-1.agent911.eth" },
      "private-key":         { type: "string" },
      "heartbeat-path":      { type: "string", default: "/tmp/agent-911/heartbeat.json" },
      "policy-id":           { type: "string" },
      "runbook-hash":        { type: "string" },
      "verifying-contract":  { type: "string" },
      "chain-id":            { type: "string" },
      "poll-ms":             { type: "string", default: "500"  },
      "threshold-ms":        { type: "string", default: "6000" },
      "expiry-secs":         { type: "string", default: "300"  },
      "axl-api-url":         { type: "string" },
      "coordinator-peer-id": { type: "string" },
    },
    strict: true,
  });
  const required = [
    "private-key", "policy-id", "runbook-hash", "verifying-contract",
    "chain-id", "axl-api-url", "coordinator-peer-id",
  ] as const;
  for (const key of required) {
    if (!values[key]) throw new Error(`--${key} is required`);
  }
  return {
    watchdogId:        values["watchdog-id"] as string,
    privateKey:        values["private-key"] as string,
    heartbeatPath:     values["heartbeat-path"] as string,
    policyId:          values["policy-id"] as `0x${string}`,
    runbookHash:       values["runbook-hash"] as `0x${string}`,
    verifyingContract: values["verifying-contract"] as `0x${string}`,
    chainId:           parseInt(values["chain-id"] as string, 10),
    pollMs:            parseInt(values["poll-ms"] as string, 10),
    thresholdMs:       parseInt(values["threshold-ms"] as string, 10),
    expirySeconds:     parseInt(values["expiry-secs"] as string, 10),
    axlApiUrl:         values["axl-api-url"] as string,
    coordinatorPeerId: values["coordinator-peer-id"] as string,
  };
}

async function main(): Promise<void> {
  const args = parse();
  const axl = new AxlClient({ apiUrl: args.axlApiUrl });

  const log = (msg: string) => process.stdout.write(`[${args.watchdogId}] ${msg}\n`);

  // Bind to our AXL node; crash loud if it's not there.
  const myPk = await axl.myPublicKey();
  log(`bound to AXL node ${args.axlApiUrl} pk=${myPk.slice(0, 16)}…`);
  log(`coordinator pk=${args.coordinatorPeerId.slice(0, 16)}…`);
  log(`polling ${args.heartbeatPath} every ${args.pollMs}ms (threshold ${args.thresholdMs}ms)`);

  let signed = false;

  const tick = async () => {
    if (signed) return;
    const age = heartbeatAgeMs(args.heartbeatPath);
    if (age <= args.thresholdMs) return;

    const observedAt = Math.floor(Date.now() / 1000);
    const expiry = observedAt + args.expirySeconds;

    const att = await signAttestation({
      privateKey:        args.privateKey,
      policyId:          args.policyId,
      runbookHash:       args.runbookHash,
      observedAt,
      expiry,
      chainId:           args.chainId,
      verifyingContract: args.verifyingContract,
    });

    const payload = {
      kind: "Agent911.FailureAttestation",
      watchdogId: args.watchdogId,
      myAxlPk: myPk,
      observedAt,
      expiry,
      signature: att.signature,
      policyId: args.policyId,
      runbookHash: args.runbookHash,
      chainId: args.chainId,
    };

    log(`heartbeat stale (${Math.round(age)}ms); signing + sending via AXL`);
    try {
      await axl.sendJson(args.coordinatorPeerId, payload);
      log(`attestation sent → ${args.coordinatorPeerId.slice(0, 16)}…`);
      signed = true;
    } catch (err) {
      log(`axl send failed: ${String(err)} — will retry`);
    }
  };

  while (true) {
    try { await tick(); } catch (err) { log(`tick error: ${String(err)}`); }
    await new Promise((r) => setTimeout(r, args.pollMs));
  }
}

main().catch((err: unknown) => {
  console.error("[watchdog-axl] fatal:", err);
  process.exit(1);
});
