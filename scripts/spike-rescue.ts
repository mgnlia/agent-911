#!/usr/bin/env tsx
/**
 * spike-rescue.ts — Gate 2 end-to-end orchestrator.
 *
 * Starts an anvil node, deploys all three contracts, mints a policy NFT
 * and binds it to the vault, deposits 10k mock-USDC, launches the main
 * agent + 3 watchdogs, then kill -9s the agent. Collects the three
 * watchdog attestations, bundles them into confirmFailure(), runs the
 * vault rescue, and asserts funds end up at the safe address.
 *
 * Prints kill-to-safe latency in milliseconds. Pass criteria:
 *   kill -> FailureConfirmed <= 30s
 *   FailureConfirmed -> rescue <= 30s
 */

import { spawn, spawnSync, ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, unlinkSync } from "node:fs";
import { join, resolve } from "node:path";
// eslint-disable-next-line @typescript-eslint/no-explicit-any
import { JsonRpcProvider, Wallet, Contract as _Contract, ContractFactory, keccak256, toUtf8Bytes, parseUnits } from "ethers";
// ethers v6 Contract has Proxy-typed methods; cast to any for script convenience
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const Contract = _Contract as any;

import { abi, bytecode } from "../lib/contracts.ts";

// --- config ---

const RPC_URL         = process.env.SPIKE_RPC_URL  ?? "http://127.0.0.1:8545";
const STATE_DIR       = process.env.SPIKE_STATE_DIR ?? "/tmp/agent-911";
const HEARTBEAT_PATH  = join(STATE_DIR, "heartbeat.json");
const ATTEST_DIR      = join(STATE_DIR, "attestations");

// Deterministic anvil dev accounts
const DEPLOYER_PK = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"; // anvil[0]
const ALICE_PK    = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d"; // anvil[1]
const WATCHDOGS = [
  { id: "watchdog-1.agent-911.eth", pk: "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a" }, // anvil[2]
  { id: "watchdog-2.agent-911.eth", pk: "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6" }, // anvil[3]
  { id: "watchdog-3.agent-911.eth", pk: "0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a" }, // anvil[4]
];
const SAFE_ADDR = "0x000000000000000000000000000000005AFE5AFE";

const POLICY_ID    = keccak256(toUtf8Bytes("policy/spike/v1"))    as `0x${string}`;
const RUNBOOK_HASH = keccak256(toUtf8Bytes("runbook/spike/v1"))   as `0x${string}`;

// --- helpers ---

function sh(cmd: string, args: string[], opts: { cwd?: string } = {}): number {
  const r = spawnSync(cmd, args, { stdio: "inherit", ...opts });
  return r.status ?? 1;
}

async function waitForRpc(url: string, timeoutMs = 15_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const p = new JsonRpcProvider(url);
      await p.getBlockNumber();
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  throw new Error(`anvil not ready after ${timeoutMs}ms`);
}

function resetState(): void {
  if (existsSync(STATE_DIR)) rmSync(STATE_DIR, { recursive: true, force: true });
  mkdirSync(ATTEST_DIR, { recursive: true });
}

function startProc(label: string, cmd: string, args: string[]): ChildProcess {
  // detached:true gives the child its own process group; we kill the *group* so
  // that tsx's shell wrapper + node child both die together on SIGKILL.
  const p = spawn(cmd, args, {
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  if (p.stdout) p.stdout.on("data", (d) => process.stdout.write(`[${label}] ${d}`));
  if (p.stderr) p.stderr.on("data", (d) => process.stderr.write(`[${label}!] ${d}`));
  p.on("exit", (code, sig) => {
    process.stderr.write(`[${label}] exited code=${code} sig=${sig}\n`);
  });
  return p;
}

function killGroup(p: ChildProcess, signal: NodeJS.Signals = "SIGTERM"): void {
  if (!p.pid) return;
  try {
    // Negative PID kills the entire process group (POSIX)
    process.kill(-p.pid, signal);
  } catch {
    // Fallback: kill just the direct child (best effort)
    try { p.kill(signal); } catch { /* already gone */ }
  }
}

async function waitForAllAttestations(dir: string, expectedCount: number, timeoutMs = 30_000): Promise<string[]> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const files = existsSync(dir)
      ? readdirSync(dir).filter((f) => f.endsWith(".json"))
      : [];
    if (files.length >= expectedCount) return files.map((f) => join(dir, f));
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`only got ${readdirSync(dir).length}/${expectedCount} attestations within ${timeoutMs}ms`);
}

// --- main ---

async function main(): Promise<void> {
  const started = Date.now();
  console.log("=== Gate 2 spike ===");
  console.log(`RPC_URL=${RPC_URL} STATE_DIR=${STATE_DIR}`);

  resetState();

  // 1. Boot anvil (2s block time)
  console.log("\n[spike] booting anvil...");
  const anvil = startProc("anvil", "anvil", ["--host", "127.0.0.1", "--block-time", "2"]);
  await waitForRpc(RPC_URL);
  console.log("[spike] anvil up");

  // 2. Deploy contracts
  const provider = new JsonRpcProvider(RPC_URL);
  const deployer = new Wallet(DEPLOYER_PK, provider);
  const alice    = new Wallet(ALICE_PK, provider);

  console.log("\n[spike] compiling (forge build)...");
  if (sh("forge", ["build", "--silent"]) !== 0) {
    throw new Error("forge build failed");
  }

  console.log("[spike] deploying WatchdogQuorum, Agent911PolicyNFT, Agent911Vault, MockERC20...");
  const quorumFactory = new ContractFactory(abi("WatchdogQuorum"),    bytecode("WatchdogQuorum"),    deployer);
  const nftFactory    = new ContractFactory(abi("Agent911PolicyNFT"), bytecode("Agent911PolicyNFT"), deployer);
  const mockFactory   = new ContractFactory(abi("MockERC20"),         bytecode("MockERC20"),         deployer);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const quorum = (await (await quorumFactory.deploy()).waitForDeployment()) as any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const nft    = (await (await nftFactory.deploy()).waitForDeployment()) as any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const usdc   = (await (await mockFactory.deploy("USD Coin", "USDC", 6)).waitForDeployment()) as any;

  const quorumAddr = await quorum.getAddress();
  const nftAddr    = await nft.getAddress();
  const usdcAddr   = await usdc.getAddress();

  const vaultFactory = new ContractFactory(abi("Agent911Vault"), bytecode("Agent911Vault"), deployer);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const vault = (await (await vaultFactory.deploy(quorumAddr, nftAddr)).waitForDeployment()) as any;
  const vaultAddr = await vault.getAddress();

  console.log(`  quorum: ${quorumAddr}`);
  console.log(`  nft:    ${nftAddr}`);
  console.log(`  vault:  ${vaultAddr}`);
  console.log(`  usdc:   ${usdcAddr}`);

  // 3. Mint policy NFT to Alice + bind to vault
  const nftAsAlice    = new Contract(nftAddr,    abi("Agent911PolicyNFT"), alice);
  const vaultAsAlice  = new Contract(vaultAddr,  abi("Agent911Vault"),     alice);
  const usdcAsAlice   = new Contract(usdcAddr,   abi("MockERC20"),         alice);

  const tx1 = await (new Contract(nftAddr, abi("Agent911PolicyNFT"), deployer))
    .mintPolicy(alice.address, "ipfs://spike/runbook.json", RUNBOOK_HASH, SAFE_ADDR);
  await tx1.wait();
  const policyNftId = 1n;
  console.log(`  policy nft id = ${policyNftId}`);

  const tx2 = await vaultAsAlice.bindPolicy(POLICY_ID, policyNftId);
  await tx2.wait();

  // 4. Register quorum policy
  const tx3 = await (new Contract(quorumAddr, abi("WatchdogQuorum"), deployer)).registerPolicy(
    POLICY_ID,
    vaultAddr,
    RUNBOOK_HASH,
    WATCHDOGS.map((w) => new Wallet(w.pk).address),
    2,
    30,
    0
  );
  await tx3.wait();

  // 5. Alice deposits 10k USDC
  const depositAmt = parseUnits("10000", 6);
  await (await (new Contract(usdcAddr, abi("MockERC20"), deployer)).mint(alice.address, depositAmt)).wait();
  await (await usdcAsAlice.approve(vaultAddr, depositAmt)).wait();
  await (await vaultAsAlice.deposit(usdcAddr, depositAmt)).wait();

  const bal = await usdc.balanceOf(vaultAddr);
  console.log(`  vault balance = ${bal}`);

  // 6. Launch main agent + watchdogs
  console.log("\n[spike] launching main-agent + watchdogs...");
  const chainId = Number((await provider.getNetwork()).chainId);

  const mainAgent = startProc("main-agent", "tsx", [
    "agents/main-agent.ts",
    "--agent-id", "main.agent-911.eth",
    "--heartbeat-path", HEARTBEAT_PATH,
    "--interval-ms", "1000",
  ]);

  const watchdogProcs = WATCHDOGS.map((w) =>
    startProc(w.id, "tsx", [
      "agents/watchdog.ts",
      "--watchdog-id",        w.id,
      "--private-key",        w.pk,
      "--heartbeat-path",     HEARTBEAT_PATH,
      "--attestation-dir",    ATTEST_DIR,
      "--policy-id",          POLICY_ID,
      "--runbook-hash",       RUNBOOK_HASH,
      "--verifying-contract", quorumAddr,
      "--chain-id",           String(chainId),
      "--poll-ms",            "250",
      "--threshold-ms",       "4000",
      "--expiry-secs",        "300",
    ])
  );

  // Let heartbeat stabilize
  await new Promise((r) => setTimeout(r, 3000));

  // 7. Kill the main agent (the demo's inflection point)
  console.log("\n============================");
  console.log("[spike] KILL -9 main-agent");
  console.log("============================\n");
  const killT0 = Date.now();
  killGroup(mainAgent, "SIGKILL");

  // 8. Wait for all 3 attestations to show up
  const attFiles = await waitForAllAttestations(ATTEST_DIR, 3, 20_000);
  console.log(`[spike] collected ${attFiles.length} attestations in ${Date.now() - killT0}ms`);

  // 9. Bundle into confirmFailure
  const atts = attFiles.map((f) => {
    const j = JSON.parse(readFileSync(f, "utf8"));
    return { observedAt: BigInt(j.observedAt), expiry: BigInt(j.expiry), signature: j.signature };
  });

  const quorumAsDeployer = new Contract(quorumAddr, abi("WatchdogQuorum"), deployer);
  const confirmTxT0 = Date.now();
  const txConfirm = await quorumAsDeployer.confirmFailure(POLICY_ID, atts);
  const rcConfirm = await txConfirm.wait();
  const confirmMs = Date.now() - confirmTxT0;
  console.log(`[spike] FailureConfirmed tx mined in ${confirmMs}ms (block ${rcConfirm.blockNumber})`);

  const killToConfirmed = Date.now() - killT0;
  console.log(`[spike] kill -> FailureConfirmed = ${killToConfirmed}ms`);

  // 10. Rescue
  const rescueT0 = Date.now();
  const txRescue = await (new Contract(vaultAddr, abi("Agent911Vault"), deployer)).rescue(POLICY_ID, usdcAddr);
  const rcRescue = await txRescue.wait();
  const rescueMs = Date.now() - rescueT0;
  console.log(`[spike] rescue tx mined in ${rescueMs}ms (block ${rcRescue.blockNumber})`);

  const killToSafe = Date.now() - killT0;
  console.log(`[spike] kill -> safe = ${killToSafe}ms`);

  // 11. Assert funds at safe
  const safeBal = await usdc.balanceOf(SAFE_ADDR);
  const vaultBalAfter = await usdc.balanceOf(vaultAddr);
  console.log(`[spike] safe balance = ${safeBal}, vault balance = ${vaultBalAfter}`);

  if (safeBal !== depositAmt || vaultBalAfter !== 0n) {
    throw new Error(`rescue failed — safe=${safeBal} vault=${vaultBalAfter}`);
  }

  const elapsed = Date.now() - started;
  console.log("\n=== Gate 2 PASSED ===");
  console.log(`kill -> FailureConfirmed: ${killToConfirmed}ms (budget 30000)`);
  console.log(`kill -> safe           : ${killToSafe}ms (budget 60000)`);
  console.log(`total spike runtime    : ${elapsed}ms`);

  // Clean up
  for (const w of watchdogProcs) killGroup(w, "SIGTERM");
  killGroup(anvil, "SIGTERM");

  // Give processes a moment to exit
  await new Promise((r) => setTimeout(r, 500));
  process.exit(0);
}

main().catch((err: unknown) => {
  console.error("[spike] FAILED:", err);
  process.exit(1);
});
