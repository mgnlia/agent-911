#!/usr/bin/env tsx
/**
 * demo-attack.ts — hallucination attack scene.
 *
 * Spec: simulate an unaffiliated attacker who tries to drain the vault by
 * fabricating FailureAttestations. The attacker generates a fresh random
 * wallet, signs an EIP-712 attestation with the *correct* policyId,
 * runbookHash, chainId, and verifyingContract — but the signing key is not
 * one of the registered watchdogs. The on-chain quorum recovers the signer
 * address, fails the `_isAuthorized` check, and reverts with
 * "unauthorized signer".
 *
 * This proves the false-positive guard is real, not a slide. The dashboard
 * picks up the rejection via /emit and renders a red "Rejected attestation"
 * card in the watchdogs pane.
 *
 * Reads live demo state from /tmp/agent-911/demo.json (written by
 * demo-start.ts). Uses anvil deployer key to fund the attacker wallet so it
 * can pay gas on the doomed tx.
 *
 * Usage:
 *   pnpm exec tsx scripts/demo-attack.ts                # live attack
 *   pnpm exec tsx scripts/demo-attack.ts --dry-run      # type+sign only,
 *                                                       # no tx, fake event
 *
 * Env (override demo state if needed):
 *   DEMO_RPC_URL              — anvil/zg testnet rpc
 *   DEMO_QUORUM_ADDR          — WatchdogQuorum address
 *   DEMO_POLICY_ID            — bytes32 policy id
 *   DEMO_RUNBOOK_HASH         — bytes32 runbook content hash
 *   DEMO_FUNDER_PK            — pk that pays gas to the attacker (default
 *                               anvil acct[0])
 *   DASHBOARD_URL             — base url for the SSE event-bus (default
 *                               http://127.0.0.1:4000)
 */

import { readFileSync, existsSync } from "node:fs";
import { JsonRpcProvider, Wallet, Contract as _Contract, keccak256, toUtf8Bytes, parseEther } from "ethers";
import { abi } from "../lib/contracts.ts";
import { signAttestation } from "../lib/eip712.ts";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const Contract = _Contract as any;

const DEMO_STATE = "/tmp/agent-911/demo.json";

// anvil deterministic account[0] — only used to fund the attacker on local.
// Override with DEMO_FUNDER_PK if running against a non-anvil chain.
const DEFAULT_FUNDER_PK = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

// Match demo-start.ts default — we recompute when state file is absent.
const DEFAULT_RUNBOOK_HASH = keccak256(toUtf8Bytes("runbook/demo/v1")) as `0x${string}`;

interface DemoState {
  addresses?: { quorum?: string; vault?: string; nft?: string; usdc?: string };
  policyId?: `0x${string}`;
  rpcUrl?: string;
  watchdogs?: Array<{ id: string; address: string }>;
}

function loadDemoState(): DemoState {
  if (!existsSync(DEMO_STATE)) return {};
  try { return JSON.parse(readFileSync(DEMO_STATE, "utf8")) as DemoState; }
  catch { return {}; }
}

interface Resolved {
  rpcUrl: string;
  quorumAddr: `0x${string}`;
  policyId: `0x${string}`;
  runbookHash: `0x${string}`;
  funderPk: string;
  dashboardUrl: string;
}

function resolveConfig(state: DemoState): Resolved {
  const rpcUrl = process.env.DEMO_RPC_URL ?? state.rpcUrl ?? "http://127.0.0.1:8545";
  const quorumAddr = (process.env.DEMO_QUORUM_ADDR ?? state.addresses?.quorum) as `0x${string}` | undefined;
  const policyId   = (process.env.DEMO_POLICY_ID   ?? state.policyId)            as `0x${string}` | undefined;
  const runbookHash = (process.env.DEMO_RUNBOOK_HASH ?? DEFAULT_RUNBOOK_HASH)   as `0x${string}`;
  const funderPk    = process.env.DEMO_FUNDER_PK ?? DEFAULT_FUNDER_PK;
  const dashboardUrl = process.env.DASHBOARD_URL ?? "http://127.0.0.1:4000";
  if (!quorumAddr) throw new Error("DEMO_QUORUM_ADDR (or demo state) required");
  if (!policyId)   throw new Error("DEMO_POLICY_ID (or demo state) required");
  return { rpcUrl, quorumAddr, policyId, runbookHash, funderPk, dashboardUrl };
}

/**
 * Pull a human-readable revert reason out of an ethers v6 error.
 * Tries: revert-string in `reason`, then `shortMessage`, then a regex on
 * the raw message.
 */
function extractRevertReason(err: unknown): string {
  if (err && typeof err === "object") {
    const e = err as { reason?: string; shortMessage?: string; info?: { error?: { message?: string } }; message?: string };
    if (typeof e.reason === "string" && e.reason.length > 0) return e.reason;
    const inner = e.info?.error?.message;
    if (typeof inner === "string") {
      const m = inner.match(/reverted with reason string '([^']+)'/) ?? inner.match(/revert\s+(.+)$/i);
      if (m && m[1]) return m[1];
      return inner;
    }
    if (typeof e.shortMessage === "string") return e.shortMessage;
    if (typeof e.message === "string") {
      const m = e.message.match(/reverted with reason string '([^']+)'/);
      if (m && m[1]) return m[1];
      return e.message;
    }
  }
  return String(err);
}

async function postEvent(dashboardUrl: string, type: string, payload: Record<string, unknown>): Promise<void> {
  try {
    const res = await fetch(`${dashboardUrl}/emit`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type, payload }),
    });
    if (!res.ok) {
      console.error(`[demo-attack] dashboard POST ${type} failed: ${res.status}`);
    }
  } catch (err) {
    console.error(`[demo-attack] dashboard unreachable at ${dashboardUrl}: ${String(err)}`);
  }
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes("--dry-run");
  const cfg = resolveConfig(loadDemoState());

  console.log(`[demo-attack] target quorum:      ${cfg.quorumAddr}`);
  console.log(`[demo-attack] target policyId:    ${cfg.policyId}`);
  console.log(`[demo-attack] target runbookHash: ${cfg.runbookHash}`);
  console.log(`[demo-attack] mode:               ${dryRun ? "DRY-RUN (no tx)" : "LIVE"}`);

  const provider = new JsonRpcProvider(cfg.rpcUrl);
  const chainId  = dryRun
    ? 31337
    : Number((await provider.getNetwork()).chainId);

  // Two fresh random wallets: an attacker who hallucinated a failure, plus
  // a sock-puppet they spun up to look like a quorum. Neither is registered.
  // The contract checks `_isAuthorized` BEFORE the duplicate-signer loop,
  // so the very first recovered signer trips "unauthorized signer".
  const attacker = Wallet.createRandom().connect(provider);
  const sock     = Wallet.createRandom().connect(provider);
  console.log(`[demo-attack] attacker wallet:    ${attacker.address}`);
  console.log(`[demo-attack] sockpuppet wallet:  ${sock.address}`);

  const now    = Math.floor(Date.now() / 1000);
  const expiry = now + 300;

  const att1 = await signAttestation({
    privateKey:        attacker.privateKey,
    policyId:          cfg.policyId,
    runbookHash:       cfg.runbookHash,
    observedAt:        now,
    expiry,
    chainId,
    verifyingContract: cfg.quorumAddr,
  });
  const att2 = await signAttestation({
    privateKey:        sock.privateKey,
    policyId:          cfg.policyId,
    runbookHash:       cfg.runbookHash,
    observedAt:        now + 1,
    expiry,
    chainId,
    verifyingContract: cfg.quorumAddr,
  });

  if (dryRun) {
    console.log("[demo-attack] (dry-run) would call confirmFailure with 2 forged attestations");
    console.log("[demo-attack] (dry-run) expected revert: 'unauthorized signer'");
    await postEvent(cfg.dashboardUrl, "attack-rejected", {
      attacker: attacker.address,
      reason:   "unauthorized signer (dry-run)",
      dryRun:   true,
    });
    return;
  }

  // Fund attacker from the deployer so it can pay gas. On anvil this is
  // free; on a real testnet you'd top this up out-of-band. We don't fund
  // sock — only `attacker` submits the tx; sock's role is just a second
  // unauthorized signature in the bundle.
  const funder = new Wallet(cfg.funderPk, provider);
  console.log(`[demo-attack] funding ${attacker.address} from ${funder.address}…`);
  const fundTx = await funder.sendTransaction({ to: attacker.address, value: parseEther("0.1") });
  await fundTx.wait();

  const quorum = new Contract(cfg.quorumAddr, abi("WatchdogQuorum"), attacker);
  const bundle = [
    { observedAt: att1.observedAt, expiry: att1.expiry, signature: att1.signature },
    { observedAt: att2.observedAt, expiry: att2.expiry, signature: att2.signature },
  ];

  console.log("[demo-attack] submitting forged confirmFailure (expected to revert)…");
  let reason = "unauthorized signer";
  try {
    const tx = await quorum.confirmFailure(cfg.policyId, bundle);
    // If we reach here, the policy guard failed open — that itself is a bug
    // worth surfacing. Do not pretend it succeeded.
    await tx.wait();
    reason = "ATTACK SUCCEEDED — policy guard failed open!";
    console.error(`[demo-attack] !!! ${reason}`);
  } catch (err) {
    reason = extractRevertReason(err);
    console.log(`[demo-attack] revert (good): ${reason}`);
  }

  await postEvent(cfg.dashboardUrl, "attack-rejected", {
    attacker: attacker.address,
    reason,
  });
  console.log("[demo-attack] dashboard notified.");
}

main().catch((err: unknown) => {
  console.error("[demo-attack] fatal:", err);
  process.exit(1);
});
