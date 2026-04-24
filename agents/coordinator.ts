#!/usr/bin/env tsx
/**
 * coordinator.ts — listens on a single AXL node's /recv inbox, collects
 * watchdog FailureAttestation messages, and when the quorum threshold is
 * met submits the bundled confirmFailure + rescue transactions.
 *
 * Used by demo-start.ts (and by demo-live.ts inline) so the dashboard
 * actually progresses from OFFLINE → SIGNED → CONFIRMED → RESCUED without
 * a human submitting the tx by hand.
 *
 * Usage:
 *   tsx agents/coordinator.ts \
 *     --axl-api-url http://127.0.0.1:9101 \
 *     --policy-id 0x... \
 *     --quorum 0x... \
 *     --vault  0x... \
 *     --token  0x... \
 *     --threshold 2 \
 *     --rpc-url http://127.0.0.1:8545 \
 *     --private-key 0x... \
 *     --chain-id 31337
 */

import { parseArgs } from "node:util";
import { JsonRpcProvider, Wallet, Contract as _Contract } from "ethers";
import { AxlClient } from "../lib/axl.ts";
import { abi } from "../lib/contracts.ts";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const Contract = _Contract as any;

interface Args {
  axlApiUrl: string;
  policyId: `0x${string}`;
  quorumAddr: `0x${string}`;
  vaultAddr: `0x${string}`;
  tokenAddr: `0x${string}`;
  threshold: number;
  rpcUrl: string;
  privateKey: string;
}

function parse(): Args {
  const { values } = parseArgs({
    options: {
      "axl-api-url": { type: "string" },
      "policy-id":   { type: "string" },
      "quorum":      { type: "string" },
      "vault":       { type: "string" },
      "token":       { type: "string" },
      "threshold":   { type: "string", default: "2" },
      "rpc-url":     { type: "string" },
      "private-key": { type: "string" },
    },
    strict: true,
  });
  for (const k of ["axl-api-url", "policy-id", "quorum", "vault", "token", "rpc-url", "private-key"] as const) {
    if (!values[k]) throw new Error(`--${k} required`);
  }
  return {
    axlApiUrl:  values["axl-api-url"] as string,
    policyId:   values["policy-id"]   as `0x${string}`,
    quorumAddr: values.quorum         as `0x${string}`,
    vaultAddr:  values.vault          as `0x${string}`,
    tokenAddr:  values.token          as `0x${string}`,
    threshold:  parseInt(values.threshold as string, 10),
    rpcUrl:     values["rpc-url"]     as string,
    privateKey: values["private-key"] as string,
  };
}

interface CollectedAtt {
  watchdogId: string;
  observedAt: bigint;
  expiry: bigint;
  signature: `0x${string}`;
}

async function main(): Promise<void> {
  const args = parse();
  const log = (m: string) => process.stdout.write(`[coordinator] ${m}\n`);

  const axl = new AxlClient({ apiUrl: args.axlApiUrl });
  const myPk = await axl.myPublicKey();
  log(`bound to AXL ${args.axlApiUrl} pk=${myPk.slice(0, 16)}…`);

  const provider = new JsonRpcProvider(args.rpcUrl);
  const signer   = new Wallet(args.privateKey, provider);

  const atts = new Map<string, CollectedAtt>();
  let submitted = false;

  log(`waiting for ${args.threshold} attestations on policy ${args.policyId}...`);

  while (!submitted) {
    try {
      const msg = await axl.recvJson<Record<string, unknown>>();
      if (msg && (msg.payload as { kind?: string }).kind === "Agent911.FailureAttestation") {
        const p = msg.payload as { watchdogId: string; observedAt: number; expiry: number; signature: `0x${string}`; policyId: `0x${string}` };
        if (p.policyId !== args.policyId) continue; // ignore mismatched runs
        if (!atts.has(p.watchdogId)) {
          atts.set(p.watchdogId, {
            watchdogId: p.watchdogId,
            observedAt: BigInt(p.observedAt),
            expiry:     BigInt(p.expiry),
            signature:  p.signature,
          });
          log(`attestation ${atts.size}/${args.threshold} from ${p.watchdogId}`);
        }

        if (atts.size >= args.threshold) {
          submitted = true;
          const bundle = Array.from(atts.values()).map(a => ({
            observedAt: a.observedAt,
            expiry:     a.expiry,
            signature:  a.signature,
          }));

          log("submitting confirmFailure...");
          const quorum = new Contract(args.quorumAddr, abi("WatchdogQuorum"), signer);
          const txC = await quorum.confirmFailure(args.policyId, bundle);
          log(`  confirmFailure hash=${txC.hash}`);
          await txC.wait();

          log("submitting rescue...");
          const vault = new Contract(args.vaultAddr, abi("Agent911Vault"), signer);
          const txR = await vault.rescue(args.policyId, args.tokenAddr);
          log(`  rescue hash=${txR.hash}`);
          await txR.wait();

          log("DONE — rescue on chain");
        }
      }
    } catch (err) {
      log(`tick error: ${String(err)}`);
    }
    if (!submitted) await new Promise(r => setTimeout(r, 200));
  }

  // Keep process alive so parent can kill it cleanly
  await new Promise<void>(() => { /* daemon */ });
}

main().catch((err: unknown) => {
  console.error("[coordinator] fatal:", err);
  process.exit(1);
});
