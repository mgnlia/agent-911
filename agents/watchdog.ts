#!/usr/bin/env tsx
/**
 * watchdog.ts — independent failure observer.
 *
 * Polls a heartbeat path every --poll-ms. When the heartbeat is older than
 * --threshold-ms, signs an EIP-712 FailureAttestation with --private-key
 * and writes it to --attestation-dir as <watchdog-id>.json for the
 * orchestrator to collect.
 *
 * In Day 4 this is swapped to AXL /send instead of a shared directory,
 * but the signing semantics stay identical.
 */

import { parseArgs } from "node:util";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { heartbeatAgeMs } from "../lib/heartbeat-bus.ts";
import { signAttestation } from "../lib/eip712.ts";

interface Args {
  watchdogId: string;
  privateKey: string;
  heartbeatPath: string;
  attestationDir: string;
  policyId: `0x${string}`;
  runbookHash: `0x${string}`;
  verifyingContract: `0x${string}`;
  chainId: number;
  pollMs: number;
  thresholdMs: number;
  expirySeconds: number;
}

function parse(): Args {
  const { values } = parseArgs({
    options: {
      "watchdog-id":       { type: "string", default: "watchdog-1.agent911.eth" },
      "private-key":       { type: "string" },
      "heartbeat-path":    { type: "string", default: "/tmp/agent-911/heartbeat.json" },
      "attestation-dir":   { type: "string", default: "/tmp/agent-911/attestations" },
      "policy-id":         { type: "string" },
      "runbook-hash":      { type: "string" },
      "verifying-contract":{ type: "string" },
      "chain-id":          { type: "string" },
      "poll-ms":           { type: "string", default: "500"  },
      "threshold-ms":      { type: "string", default: "6000" },
      "expiry-secs":       { type: "string", default: "300"  },
    },
    strict: true,
  });
  const required = ["private-key", "policy-id", "runbook-hash", "verifying-contract", "chain-id"] as const;
  for (const key of required) {
    if (!values[key]) {
      throw new Error(`--${key} is required`);
    }
  }
  return {
    watchdogId:        values["watchdog-id"] as string,
    privateKey:        values["private-key"] as string,
    heartbeatPath:     values["heartbeat-path"] as string,
    attestationDir:    values["attestation-dir"] as string,
    policyId:          values["policy-id"] as `0x${string}`,
    runbookHash:       values["runbook-hash"] as `0x${string}`,
    verifyingContract: values["verifying-contract"] as `0x${string}`,
    chainId:           parseInt(values["chain-id"] as string, 10),
    pollMs:            parseInt(values["poll-ms"] as string, 10),
    thresholdMs:       parseInt(values["threshold-ms"] as string, 10),
    expirySeconds:     parseInt(values["expiry-secs"] as string, 10),
  };
}

async function main(): Promise<void> {
  const args = parse();
  mkdirSync(args.attestationDir, { recursive: true });

  let missed = 0;
  let signed = false;

  const log = (msg: string) => {
    process.stdout.write(`[${args.watchdogId}] ${msg}\n`);
  };

  log(`polling ${args.heartbeatPath} every ${args.pollMs}ms (threshold ${args.thresholdMs}ms)`);

  const tick = async () => {
    if (signed) return;
    const age = heartbeatAgeMs(args.heartbeatPath);
    if (age > args.thresholdMs) {
      missed++;
      log(`heartbeat stale: age=${Math.round(age)}ms missed=${missed}`);
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

      const outPath = join(args.attestationDir, `${args.watchdogId}.json`);
      writeFileSync(
        outPath,
        JSON.stringify(
          {
            watchdogId: args.watchdogId,
            observedAt,
            expiry,
            signature:  att.signature,
          },
          null,
          2
        )
      );
      log(`signed attestation → ${outPath}`);
      signed = true;
    } else {
      // healthy
      if (missed > 0) {
        log(`heartbeat recovered (age=${Math.round(age)}ms)`);
        missed = 0;
      }
    }
  };

  // Run forever; orchestrator kills us
  while (true) {
    try {
      await tick();
    } catch (err) {
      log(`tick error: ${String(err)}`);
    }
    await new Promise((r) => setTimeout(r, args.pollMs));
  }
}

main().catch((err: unknown) => {
  console.error("[watchdog] fatal:", err);
  process.exit(1);
});
