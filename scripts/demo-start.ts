#!/usr/bin/env tsx
/**
 * demo-start.ts — bring up the full Agent-911 demo environment.
 *
 * Sequence:
 *   1. Ensure AXL 3-node mesh is running (infra/axl/up.sh).
 *   2. Boot anvil (or connect to an existing RPC via DEMO_RPC_URL).
 *   3. Deploy WatchdogQuorum + Agent911PolicyNFT + Agent911Vault + MockERC20.
 *   4. Mint policy NFT to Alice, bind vault, deposit 10k mUSDC.
 *   5. Launch main-agent on one process + 3 AXL-routed watchdogs.
 *   6. Start the event-bus server (SSE) on :4000 and the static dashboard on :3000.
 *   7. Write demo state to /tmp/agent-911/demo.json for kill/reset scripts.
 *
 * The process stays running until Ctrl-C (or `demo-reset`).
 */

import { spawn, ChildProcess } from "node:child_process";
import { mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { JsonRpcProvider, Wallet, ContractFactory, Contract as _Contract, keccak256, toUtf8Bytes, parseUnits } from "ethers";
import { abi, bytecode } from "../lib/contracts.ts";
import { AxlClient } from "../lib/axl.ts";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const Contract = _Contract as any;

const STATE_DIR      = "/tmp/agent-911";
const HEARTBEAT_PATH = join(STATE_DIR, "heartbeat.json");
const DEMO_STATE     = join(STATE_DIR, "demo.json");
const RPC_URL        = process.env.DEMO_RPC_URL ?? "http://127.0.0.1:8545";

// Deterministic anvil accounts
const DEPLOYER_PK = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const ALICE_PK    = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
const WATCHDOGS = [
  { id: "watchdog-1.agent-911.eth", pk: "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a", axl: "http://127.0.0.1:9101" },
  { id: "watchdog-2.agent-911.eth", pk: "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6", axl: "http://127.0.0.1:9102" },
  { id: "watchdog-3.agent-911.eth", pk: "0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a", axl: "http://127.0.0.1:9103" },
];
const SAFE_ADDR_FALLBACK = "0x000000000000000000000000000000005AFE5AFE";
const ENS_SAFE_NAME      = "safe.agent-911.eth";
const MAINNET_RPC        = "https://ethereum-rpc.publicnode.com";
const POLICY_ID    = keccak256(toUtf8Bytes("policy/demo/v1")) as `0x${string}`;
const RUNBOOK_HASH = keccak256(toUtf8Bytes("runbook/demo/v1")) as `0x${string}`;

/** Resolve safe.agent-911.eth on mainnet. Falls back to the sentinel so the demo
 *  doesn't break if the user hasn't set the ENS record yet. ENS resolution at
 *  rescue time means transferring `safe.agent-911.eth` on mainnet redirects every
 *  future rescue — that's the load-bearing ENS integration. */
async function resolveSafeAddress(): Promise<string> {
  try {
    const p = new JsonRpcProvider(MAINNET_RPC);
    const a = await p.resolveName(ENS_SAFE_NAME);
    if (a) {
      console.log(`[demo] resolved ${ENS_SAFE_NAME} → ${a}`);
      return a;
    }
    console.warn(`[demo] WARN: ${ENS_SAFE_NAME} did not resolve; using fallback ${SAFE_ADDR_FALLBACK}`);
  } catch (e) {
    console.warn(`[demo] WARN: ENS resolution failed (${(e as Error).message}); using fallback`);
  }
  return SAFE_ADDR_FALLBACK;
}

function startProc(label: string, cmd: string, args: string[], env?: NodeJS.ProcessEnv): ChildProcess {
  const p = spawn(cmd, args, { stdio: ["ignore", "inherit", "inherit"], detached: true, env: { ...process.env, ...env } });
  console.log(`[demo] launched ${label} pid=${p.pid}`);
  return p;
}

function killGroup(p: ChildProcess): void {
  if (!p.pid) return;
  try { process.kill(-p.pid, "SIGKILL"); } catch { /* gone */ }
}

async function waitForRpc(url: string, timeoutMs = 15_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try { await new JsonRpcProvider(url).getBlockNumber(); return; } catch { await new Promise(r => setTimeout(r, 250)); }
  }
  throw new Error("rpc not ready");
}

async function waitForAxl(apiUrl: string, timeoutMs = 30_000): Promise<string> {
  const cli = new AxlClient({ apiUrl, timeoutMs: 2_000 });
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try { return await cli.myPublicKey(); } catch { await new Promise(r => setTimeout(r, 500)); }
  }
  throw new Error(`axl not ready: ${apiUrl}`);
}

async function main(): Promise<void> {
  if (existsSync(STATE_DIR)) rmSync(STATE_DIR, { recursive: true, force: true });
  mkdirSync(STATE_DIR, { recursive: true });

  // --- 0. resolve safe address from ENS ---
  const SAFE_ADDR = await resolveSafeAddress();

  // --- 1. AXL ---
  console.log("[demo] ensuring AXL mesh is up...");
  const repoRoot = process.cwd();
  const axlUpProc = spawn("bash", [join(repoRoot, "infra/axl/up.sh")], { stdio: "inherit", env: process.env });
  await new Promise<void>((res) => axlUpProc.on("exit", () => res()));

  const pks: string[] = [];
  for (const w of WATCHDOGS) {
    pks.push(await waitForAxl(w.axl));
  }
  console.log("[demo] AXL nodes:");
  for (let i = 0; i < WATCHDOGS.length; i++) console.log(`  ${WATCHDOGS[i]!.id}: ${pks[i]!.slice(0, 16)}…`);
  const coordinatorPk = pks[0]!;

  // --- 2. anvil ---
  console.log("[demo] booting anvil...");
  const anvil = startProc("anvil", "anvil", ["--host", "127.0.0.1", "--block-time", "2"]);
  await waitForRpc(RPC_URL);

  // --- 3. deploy ---
  const provider = new JsonRpcProvider(RPC_URL);
  const deployer = new Wallet(DEPLOYER_PK, provider);
  const alice    = new Wallet(ALICE_PK, provider);

  const qF = new ContractFactory(abi("WatchdogQuorum"),    bytecode("WatchdogQuorum"),    deployer);
  const nF = new ContractFactory(abi("Agent911PolicyNFT"), bytecode("Agent911PolicyNFT"), deployer);
  const mF = new ContractFactory(abi("MockERC20"),         bytecode("MockERC20"),         deployer);
  // NB: deploy NFT first; WatchdogQuorum constructor now takes IERC721 policyNFT
  // (auth fix: registerPolicy gated on policyNFT.ownerOf(tokenId) == msg.sender).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const nft    = (await (await nF.deploy()).waitForDeployment()) as any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const quorum = (await (await qF.deploy(await nft.getAddress())).waitForDeployment()) as any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const usdc   = (await (await mF.deploy("USD Coin (mock)", "mUSDC", 6)).waitForDeployment()) as any;
  const vF = new ContractFactory(abi("Agent911Vault"), bytecode("Agent911Vault"), deployer);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const vault  = (await (await vF.deploy(await quorum.getAddress(), await nft.getAddress())).waitForDeployment()) as any;

  const addresses = {
    quorum: await quorum.getAddress(),
    nft:    await nft.getAddress(),
    vault:  await vault.getAddress(),
    usdc:   await usdc.getAddress(),
  };
  console.log("[demo] contracts:", addresses);

  // --- 4. setup: mint policy, bind, deposit ---
  await (await new Contract(addresses.nft, abi("Agent911PolicyNFT"), deployer)
    .mintPolicy(alice.address, "ipfs://agent-911/demo-runbook.enc", RUNBOOK_HASH, SAFE_ADDR)).wait();
  await (await new Contract(addresses.vault, abi("Agent911Vault"), alice).bindPolicy(POLICY_ID, 1n)).wait();
  // NB: registerPolicy now requires tokenId — gated on policyNFT.ownerOf(tokenId) == msg.sender
  // (front-running fix in WatchdogQuorum.sol). Demo mints tokenId=1 to Alice; deployer
  // calls registerPolicy via Alice's signer below.
  await (await new Contract(addresses.quorum, abi("WatchdogQuorum"), alice).registerPolicy(
    POLICY_ID, 1n, addresses.vault, RUNBOOK_HASH,
    WATCHDOGS.map(w => new Wallet(w.pk).address),
    2, 30, 0,
  )).wait();
  const amt = parseUnits("10000", 6);
  await (await new Contract(addresses.usdc, abi("MockERC20"), deployer).mint(alice.address, amt)).wait();
  await (await new Contract(addresses.usdc, abi("MockERC20"), alice).approve(addresses.vault, amt)).wait();
  await (await new Contract(addresses.vault, abi("Agent911Vault"), alice).deposit(addresses.usdc, amt)).wait();

  console.log("[demo] vault seeded with 10k mUSDC. safe is empty.");

  // --- 5. agents ---
  console.log("[demo] launching main-agent + 3 watchdogs...");
  const mainAgent = startProc("main-agent", "tsx", [
    "agents/main-agent.ts",
    "--agent-id", "main.agent-911.eth",
    "--heartbeat-path", HEARTBEAT_PATH,
    "--interval-ms", "1000",
  ]);

  const chainId = Number((await provider.getNetwork()).chainId);
  const wdProcs: ChildProcess[] = [];
  for (const w of WATCHDOGS) {
    wdProcs.push(startProc(w.id, "tsx", [
      "agents/watchdog-axl.ts",
      "--watchdog-id",         w.id,
      "--private-key",         w.pk,
      "--heartbeat-path",      HEARTBEAT_PATH,
      "--policy-id",           POLICY_ID,
      "--runbook-hash",        RUNBOOK_HASH,
      "--verifying-contract",  addresses.quorum,
      "--chain-id",            String(chainId),
      "--poll-ms",             "250",
      "--threshold-ms",        "4000",
      "--expiry-secs",         "300",
      "--axl-api-url",         w.axl,
      "--coordinator-peer-id", coordinatorPk,
    ]));
  }

  // --- 6. event bus + dashboard + coordinator (single process) ---
  // event-bus is both the SSE broadcaster AND the coordinator: it polls the
  // coord AXL node's /recv inbox once, emits 'attestation' events for the UI,
  // and submits confirmFailure + rescue when the threshold is met.
  const eventBus = startProc("event-bus", "tsx", ["scripts/event-bus.ts"], {
    DEMO_RPC_URL:       RPC_URL,
    DEMO_QUORUM_ADDR:   addresses.quorum,
    DEMO_VAULT_ADDR:    addresses.vault,
    DEMO_NFT_ADDR:      addresses.nft,
    DEMO_USDC_ADDR:     addresses.usdc,
    DEMO_POLICY_ID:     POLICY_ID,
    DEMO_SAFE_ADDR:     SAFE_ADDR,
    DEMO_HEARTBEAT:     HEARTBEAT_PATH,
    DEMO_COORD_AXL:     WATCHDOGS[0]!.axl,
    DEMO_COORD_PK:      DEPLOYER_PK,
    DEMO_THRESHOLD:     "2",
  });

  // --- 7. persist state ---
  writeFileSync(DEMO_STATE, JSON.stringify({
    pids: {
      anvil:     anvil.pid,
      mainAgent: mainAgent.pid,
      watchdogs: wdProcs.map(p => p.pid),
      eventBus:  eventBus.pid,
    },
    addresses,
    policyId: POLICY_ID,
    safe: SAFE_ADDR,
    watchdogs: WATCHDOGS.map(w => ({ id: w.id, axl: w.axl, address: new Wallet(w.pk).address })),
    rpcUrl: RPC_URL,
    coordinatorPk,
    startedAt: new Date().toISOString(),
  }, null, 2));

  console.log(`\n[demo] up. state: ${DEMO_STATE}`);
  console.log("[demo] dashboard: http://127.0.0.1:4000/");
  console.log("[demo] next: 'pnpm demo:kill' to kill main-agent, watch rescue happen");
  console.log("[demo] (Ctrl-C to tear down)");

  // Optional: auto-launch the hallucination attack scene before the kill.
  // Fires ~5s after the demo is live so it lands while the main agent is
  // still healthy — the pitch line is "an attacker tries to drain the vault
  // before the agent is even down, and the on-chain quorum rejects it."
  if (process.env.DEMO_ATTACK === "1") {
    setTimeout(() => {
      console.log("[demo] DEMO_ATTACK=1 → launching demo-attack scene…");
      const p = startProc("demo-attack", "tsx", ["scripts/demo-attack.ts"]);
      // Detach so it doesn't keep demo-start alive if the user Ctrl-Cs.
      p.unref?.();
    }, 5_000);
  }

  // Wait forever until SIGINT; cleanup on exit
  const shutdown = () => {
    console.error("\n[demo] shutting down...");
    for (const p of [mainAgent, eventBus, anvil, ...wdProcs]) killGroup(p);
    setTimeout(() => process.exit(0), 300);
  };
  process.on("SIGINT",  shutdown);
  process.on("SIGTERM", shutdown);

  await new Promise<void>(() => { /* run until signal */ });
}

main().catch((err: unknown) => {
  console.error("[demo-start] FAILED:", err);
  process.exit(1);
});
