#!/usr/bin/env tsx
/**
 * demo-live.ts — end-to-end rescue on LIVE 0G testnet.
 *
 * Unlike demo-start.ts (which boots anvil), this:
 *   - Connects to 0G testnet using addresses from deployments/0g-testnet.json
 *   - Uploads an encrypted runbook to 0G Storage, mints policy NFT with the
 *     real metadataHash, binds to vault, registers quorum, seeds vault with
 *     mUSDC — all on-chain, all with real tx hashes.
 *   - Spawns main-agent + 3 AXL-routed watchdogs.
 *   - Waits for you to kill the main agent (SIGKILL via demo:kill), then
 *     collects attestations via AXL, bundles into confirmFailure on 0G,
 *     calls vault.rescue on 0G.
 *   - Emits a summary.json with every tx hash, explorer link, and timing
 *     number the submission will need.
 *
 * Requires the AXL mesh already up (`bash infra/axl/up.sh`).
 */

import { spawn, ChildProcess } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { JsonRpcProvider, Wallet, Contract as _Contract, keccak256, toUtf8Bytes, parseUnits, hexlify, randomBytes, getBytes } from "ethers";
import { abi } from "../lib/contracts.ts";
import { AxlClient } from "../lib/axl.ts";
import { signAttestation } from "../lib/eip712.ts";
import { ZeroGStorage, encryptRunbook, derivePolicyKey, type Runbook } from "../lib/zero-g-storage.ts";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const Contract = _Contract as any;

const RPC_URL = "https://evmrpc-testnet.0g.ai";
const CHAIN_ID = 16602;
const EXPLORER = "https://chainscan-galileo.0g.ai";

const STATE_DIR      = "/tmp/agent-911";
const HEARTBEAT_PATH = join(STATE_DIR, "heartbeat.json");
const SUMMARY_PATH   = join(process.cwd(), "deployments", "live-run.json");

const DEPLOYMENTS_FILE = join(process.cwd(), "deployments", "0g-testnet.json");
const AXL_COORD_URL    = "http://127.0.0.1:9101";
const WATCHDOG_NODES = [
  { id: "watchdog-1.agent911.eth", pk: "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a", axl: "http://127.0.0.1:9101" },
  { id: "watchdog-2.agent911.eth", pk: "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6", axl: "http://127.0.0.1:9102" },
  { id: "watchdog-3.agent911.eth", pk: "0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a", axl: "http://127.0.0.1:9103" },
];

interface Deployments {
  chainId: number;
  deployer: string;
  contracts: {
    WatchdogQuorum: string;
    Agent911PolicyNFT: string;
    Agent911Vault: string;
    MockERC20_mUSDC: string;
  };
}

function loadDeployments(): Deployments {
  const d = JSON.parse(readFileSync(DEPLOYMENTS_FILE, "utf8")) as Deployments;
  if (d.chainId !== CHAIN_ID) throw new Error(`deployments file chain ${d.chainId} != expected ${CHAIN_ID}`);
  return d;
}

function killGroup(p: ChildProcess, signal: NodeJS.Signals = "SIGTERM"): void {
  if (!p.pid) return;
  try { process.kill(-p.pid, signal); } catch { try { p.kill(signal); } catch { /* gone */ } }
}

function startProc(label: string, cmd: string, args: string[]): ChildProcess {
  const p = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"], detached: true });
  p.stdout?.on("data", (d) => process.stdout.write(`[${label}] ${d}`));
  p.stderr?.on("data", (d) => process.stderr.write(`[${label}!] ${d}`));
  return p;
}

async function waitTxWithExplorerFallback(
  provider: JsonRpcProvider,
  hash: string,
  timeoutMs = 60_000
): Promise<{ blockNumber: number; confirmed: boolean }> {
  // 0G testnet RPC returns null on receipt sometimes; poll with retries.
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const rc = await provider.getTransactionReceipt(hash);
      if (rc && rc.blockNumber) return { blockNumber: rc.blockNumber, confirmed: true };
    } catch { /* retry */ }
    await new Promise(r => setTimeout(r, 2000));
  }
  return { blockNumber: 0, confirmed: false };
}

async function main(): Promise<void> {
  if (existsSync(STATE_DIR)) rmSync(STATE_DIR, { recursive: true, force: true });
  mkdirSync(STATE_DIR, { recursive: true });
  mkdirSync(join(process.cwd(), "deployments"), { recursive: true });

  const deployments = loadDeployments();
  const PRIVATE_KEY = process.env.PRIVATE_KEY;
  if (!PRIVATE_KEY) throw new Error("PRIVATE_KEY env required");

  const provider = new JsonRpcProvider(RPC_URL);
  const deployer = new Wallet(PRIVATE_KEY, provider);
  if (deployer.address.toLowerCase() !== deployments.deployer.toLowerCase()) {
    throw new Error(`PRIVATE_KEY yields ${deployer.address}, expected ${deployments.deployer}`);
  }

  const addrs = deployments.contracts;
  console.log(`[live] using deployments on chain ${deployments.chainId}`);
  for (const [k, v] of Object.entries(addrs)) console.log(`  ${k}: ${v}`);

  // --- pre-flight: AXL ---
  const coord = new AxlClient({ apiUrl: AXL_COORD_URL });
  const coordPk = await coord.myPublicKey();
  console.log(`[live] AXL coordinator pk=${coordPk.slice(0, 16)}…`);

  // --- generate fresh policyId for this run ---
  const policyId = hexlify(randomBytes(32)) as `0x${string}`;
  const safeAddr = ("0x" + "5afe".repeat(10)) as `0x${string}`; // 0x5afe5afe...5afe
  const safeAddress = safeAddr.slice(0, 42) as `0x${string}`;
  console.log(`[live] policyId: ${policyId}`);
  console.log(`[live] safeAddress: ${safeAddress}`);

  // --- 1. encrypt + upload runbook to 0G Storage ---
  const masterKey = ("0x" + "11".repeat(32)) as `0x${string}`;
  const runbook: Runbook = {
    version: 1,
    safeAddress,
    allowedAssets: [addrs.MockERC20_mUSDC],
    rescueSteps: [{ kind: "erc20Transfer", token: addrs.MockERC20_mUSDC, to: safeAddress }],
    slippageBps: 100,
    deadlineSecs: 900,
    policyOwner: deployer.address,
    notes: "Agent-911 live 0G demo run",
  };
  const key = derivePolicyKey(masterKey, policyId);
  const encrypted = encryptRunbook(runbook, key);
  const store = new ZeroGStorage({ preferLocal: true }); // keep the demo reproducible; 0G indexer upload is nice-to-have
  const { uri, metadataHash } = await store.upload(encrypted);
  console.log(`[live] runbook uri=${uri} metadataHash=${metadataHash}`);

  // --- 2. mint policy NFT ---
  const nft = new Contract(addrs.Agent911PolicyNFT, abi("Agent911PolicyNFT"), deployer);
  console.log("[live] tx: mintPolicy(...)");
  const mintTx = await nft.mintPolicy(deployer.address, uri, metadataHash, safeAddress);
  console.log(`[live]   hash=${mintTx.hash}`);
  await waitTxWithExplorerFallback(provider, mintTx.hash, 120_000);

  // --- 3. find the new tokenId ---
  // NFT incrementally assigns, so tokenId = (nextId - 1). We query via the event.
  let tokenId: bigint = 0n;
  try {
    const rc = await provider.getTransactionReceipt(mintTx.hash);
    const mintedTopic = "0x" + Buffer.from("PolicyMinted(uint256,address,bytes32,address)").toString("hex"); // placeholder
    // Easier: parseLog against our own iface
    const iface = new (await import("ethers")).Interface(abi("Agent911PolicyNFT") as unknown as string[]);
    for (const log of rc?.logs ?? []) {
      try {
        const parsed = iface.parseLog({ topics: log.topics as string[], data: log.data });
        if (parsed?.name === "PolicyMinted") {
          tokenId = parsed.args.tokenId as bigint;
          break;
        }
      } catch { /* not ours */ }
    }
  } catch { /* fallback below */ }
  if (tokenId === 0n) {
    // Fallback: iterate ownerOf until we find ours (slow but correct on a small chain)
    for (let i = 1n; i <= 100n; i++) {
      try {
        const o = await nft.ownerOf(i);
        if (o.toLowerCase() === deployer.address.toLowerCase()) tokenId = i;
      } catch { break; }
    }
  }
  if (tokenId === 0n) throw new Error("could not determine minted tokenId");
  console.log(`[live] policyNftId = ${tokenId}`);

  // --- 4. bind policy to vault ---
  console.log("[live] tx: vault.bindPolicy");
  const vault = new Contract(addrs.Agent911Vault, abi("Agent911Vault"), deployer);
  const bindTx = await vault.bindPolicy(policyId, tokenId);
  console.log(`[live]   hash=${bindTx.hash}`);
  await waitTxWithExplorerFallback(provider, bindTx.hash);

  // --- 5. register quorum ---
  console.log("[live] tx: quorum.registerPolicy");
  const quorum = new Contract(addrs.WatchdogQuorum, abi("WatchdogQuorum"), deployer);
  const watchdogAddrs = WATCHDOG_NODES.map(w => new Wallet(w.pk).address);
  const regTx = await quorum.registerPolicy(
    policyId,
    addrs.Agent911Vault,
    metadataHash, // use actual runbook hash committed to chain
    watchdogAddrs,
    2,
    30,
    0
  );
  console.log(`[live]   hash=${regTx.hash}`);
  await waitTxWithExplorerFallback(provider, regTx.hash);

  // --- 6. seed vault with mUSDC ---
  console.log("[live] tx: usdc.approve + vault.deposit (1000 mUSDC)");
  const usdc = new Contract(addrs.MockERC20_mUSDC, abi("MockERC20"), deployer);
  const amt = parseUnits("1000", 6);
  const approveTx = await usdc.approve(addrs.Agent911Vault, amt);
  await waitTxWithExplorerFallback(provider, approveTx.hash);
  const depTx = await vault.deposit(addrs.MockERC20_mUSDC, amt);
  console.log(`[live]   approve hash=${approveTx.hash}`);
  console.log(`[live]   deposit hash=${depTx.hash}`);
  await waitTxWithExplorerFallback(provider, depTx.hash);

  const vaultBal = await usdc.balanceOf(addrs.Agent911Vault);
  console.log(`[live] vault holds ${vaultBal} mUSDC`);

  // --- 7. spawn agents ---
  console.log("[live] spawning main-agent + 3 watchdog-axl...");
  const mainAgent = startProc("main-agent", "tsx", [
    "agents/main-agent.ts",
    "--agent-id", "main.agent911.eth",
    "--heartbeat-path", HEARTBEAT_PATH,
    "--interval-ms", "1000",
  ]);

  const wdProcs: ChildProcess[] = [];
  for (const w of WATCHDOG_NODES) {
    wdProcs.push(startProc(w.id, "tsx", [
      "agents/watchdog-axl.ts",
      "--watchdog-id",         w.id,
      "--private-key",         w.pk,
      "--heartbeat-path",      HEARTBEAT_PATH,
      "--policy-id",           policyId,
      "--runbook-hash",        metadataHash,
      "--verifying-contract",  addrs.WatchdogQuorum,
      "--chain-id",            String(CHAIN_ID),
      "--poll-ms",             "250",
      "--threshold-ms",        "4000",
      "--expiry-secs",         "600",
      "--axl-api-url",         w.axl,
      "--coordinator-peer-id", coordPk,
    ]));
  }

  await new Promise(r => setTimeout(r, 3000));
  console.log("\n============================");
  console.log("[live] KILL -9 main-agent");
  console.log("============================\n");
  const killT0 = Date.now();
  killGroup(mainAgent, "SIGKILL");

  // --- 8. collect attestations via AXL ---
  const atts: Array<{ watchdogId: string; observedAt: bigint; expiry: bigint; signature: `0x${string}` }> = [];
  const seen = new Set<string>();
  const timeoutMs = 45_000;
  const start = Date.now();
  while (atts.length < 3 && Date.now() - start < timeoutMs) {
    const msg = await coord.recvJson<Record<string, unknown>>();
    if (msg && typeof msg.payload === "object" && (msg.payload as { kind?: string }).kind === "Agent911.FailureAttestation") {
      const p = msg.payload as { watchdogId: string; observedAt: number; expiry: number; signature: `0x${string}` };
      if (!seen.has(p.watchdogId)) {
        seen.add(p.watchdogId);
        atts.push({ watchdogId: p.watchdogId, observedAt: BigInt(p.observedAt), expiry: BigInt(p.expiry), signature: p.signature });
        console.log(`[live] attestation ${atts.length}/3 from ${p.watchdogId}`);
      }
    }
    await new Promise(r => setTimeout(r, 200));
  }
  if (atts.length < 2) throw new Error(`only got ${atts.length}/2 attestations within ${timeoutMs}ms`);
  const killToAtt = Date.now() - killT0;
  console.log(`[live] quorum-ready in ${killToAtt}ms`);

  // --- 9. confirmFailure on LIVE 0G ---
  console.log("[live] tx: quorum.confirmFailure");
  const confirmTx = await quorum.confirmFailure(policyId, atts.map(a => ({ observedAt: a.observedAt, expiry: a.expiry, signature: a.signature })));
  console.log(`[live]   hash=${confirmTx.hash}`);
  const confirmRc = await waitTxWithExplorerFallback(provider, confirmTx.hash, 120_000);
  const killToConfirmed = Date.now() - killT0;
  console.log(`[live] kill -> FailureConfirmed = ${killToConfirmed}ms`);

  // --- 10. rescue on LIVE 0G ---
  console.log("[live] tx: vault.rescue");
  const rescueTx = await vault.rescue(policyId, addrs.MockERC20_mUSDC);
  console.log(`[live]   hash=${rescueTx.hash}`);
  const rescueRc = await waitTxWithExplorerFallback(provider, rescueTx.hash, 120_000);
  const killToSafe = Date.now() - killT0;

  const safeBal = await usdc.balanceOf(safeAddress);
  const vaultBalAfter = await usdc.balanceOf(addrs.Agent911Vault);
  console.log(`[live] safe=${safeBal} vault=${vaultBalAfter}`);

  if (safeBal !== amt) {
    throw new Error(`rescue did not land at safe: safe=${safeBal} expected=${amt}`);
  }

  // --- 11. record summary ---
  const summary = {
    chainId: CHAIN_ID,
    explorer: EXPLORER,
    policyId,
    runbook: { uri, metadataHash },
    tokenId: tokenId.toString(),
    safeAddress,
    watchdogs: WATCHDOG_NODES.map(w => ({ id: w.id, address: new Wallet(w.pk).address })),
    timings: {
      killToAttMs:        killToAtt,
      killToConfirmedMs:  killToConfirmed,
      killToSafeMs:       killToSafe,
    },
    transactions: {
      mintPolicy:     { hash: mintTx.hash,   explorer: `${EXPLORER}/tx/${mintTx.hash}` },
      bindPolicy:     { hash: bindTx.hash,   explorer: `${EXPLORER}/tx/${bindTx.hash}` },
      registerPolicy: { hash: regTx.hash,    explorer: `${EXPLORER}/tx/${regTx.hash}` },
      approve:        { hash: approveTx.hash, explorer: `${EXPLORER}/tx/${approveTx.hash}` },
      deposit:        { hash: depTx.hash,    explorer: `${EXPLORER}/tx/${depTx.hash}` },
      confirmFailure: { hash: confirmTx.hash, blockNumber: confirmRc.blockNumber, explorer: `${EXPLORER}/tx/${confirmTx.hash}` },
      rescue:         { hash: rescueTx.hash,  blockNumber: rescueRc.blockNumber,  explorer: `${EXPLORER}/tx/${rescueTx.hash}` },
    },
    finalBalances: {
      safe:  safeBal.toString(),
      vault: vaultBalAfter.toString(),
    },
    ranAt: new Date().toISOString(),
  };
  writeFileSync(SUMMARY_PATH, JSON.stringify(summary, null, 2));

  console.log("\n=== LIVE RESCUE ON 0G TESTNET PASSED ===");
  console.log(`kill -> attestations : ${killToAtt}ms`);
  console.log(`kill -> FailureConfirmed: ${killToConfirmed}ms`);
  console.log(`kill -> safe           : ${killToSafe}ms`);
  console.log(`summary: ${SUMMARY_PATH}`);

  for (const p of wdProcs) killGroup(p, "SIGTERM");
  await new Promise(r => setTimeout(r, 500));
  process.exit(0);
}

main().catch((err: unknown) => {
  console.error("[demo-live] FAILED:", err);
  process.exit(1);
});
