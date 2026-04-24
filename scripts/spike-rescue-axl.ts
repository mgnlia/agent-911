#!/usr/bin/env tsx
/**
 * spike-rescue-axl.ts — Gate 2 with the REAL AXL mesh.
 *
 * Differences from scripts/spike-rescue.ts (file-bus version):
 *   - 3 watchdog processes each bind to a distinct AXL node
 *     (api_port 9101/9102/9103) with distinct private keys.
 *   - Attestations are sent via AXL /send to a coordinator peer
 *     (defaults to node-1).
 *   - This orchestrator polls /recv on node-1 to collect them.
 *
 * Assumes `infra/axl/up.sh` has already started the mesh.
 */

import { spawn, ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { JsonRpcProvider, Wallet, ContractFactory, Contract as _Contract, keccak256, toUtf8Bytes, parseUnits } from "ethers";
import { abi, bytecode } from "../lib/contracts.ts";
import { AxlClient } from "../lib/axl.ts";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const Contract = _Contract as any;

const RPC_URL        = process.env.SPIKE_RPC_URL   ?? "http://127.0.0.1:8545";
const STATE_DIR      = process.env.SPIKE_STATE_DIR ?? "/tmp/agent-911";
const HEARTBEAT_PATH = join(STATE_DIR, "heartbeat.json");

const DEPLOYER_PK = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const ALICE_PK    = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
const WATCHDOGS = [
  { id: "watchdog-1.agent911.eth", pk: "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a", axl: "http://127.0.0.1:9101" },
  { id: "watchdog-2.agent911.eth", pk: "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6", axl: "http://127.0.0.1:9102" },
  { id: "watchdog-3.agent911.eth", pk: "0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a", axl: "http://127.0.0.1:9103" },
];
const SAFE_ADDR = "0x000000000000000000000000000000005AFE5AFE";

const POLICY_ID    = keccak256(toUtf8Bytes("policy/spike-axl/v1"))  as `0x${string}`;
const RUNBOOK_HASH = keccak256(toUtf8Bytes("runbook/spike-axl/v1")) as `0x${string}`;

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

function resetState(): void {
  if (existsSync(STATE_DIR)) rmSync(STATE_DIR, { recursive: true, force: true });
  mkdirSync(STATE_DIR, { recursive: true });
}

async function waitForRpc(url: string, timeoutMs = 15_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try { await new JsonRpcProvider(url).getBlockNumber(); return; } catch { await new Promise(r => setTimeout(r, 250)); }
  }
  throw new Error(`rpc not ready: ${url}`);
}

interface CollectedAtt {
  watchdogId: string;
  observedAt: bigint;
  expiry: bigint;
  signature: `0x${string}`;
}

async function collectAttestations(coordinator: AxlClient, need: number, timeoutMs: number): Promise<CollectedAtt[]> {
  const start = Date.now();
  const seen = new Set<string>();
  const out: CollectedAtt[] = [];
  while (Date.now() - start < timeoutMs) {
    const msg = await coordinator.recvJson<{
      kind: string;
      watchdogId: string;
      observedAt: number;
      expiry: number;
      signature: `0x${string}`;
    }>();
    if (msg && msg.payload.kind === "Agent911.FailureAttestation") {
      if (!seen.has(msg.payload.watchdogId)) {
        seen.add(msg.payload.watchdogId);
        out.push({
          watchdogId: msg.payload.watchdogId,
          observedAt: BigInt(msg.payload.observedAt),
          expiry: BigInt(msg.payload.expiry),
          signature: msg.payload.signature,
        });
        console.log(`[spike-axl] attestation ${out.length}/${need} from ${msg.payload.watchdogId.slice(0, 28)}… via AXL`);
        if (out.length >= need) return out;
      }
    }
    await new Promise(r => setTimeout(r, 200));
  }
  throw new Error(`only got ${out.length}/${need} attestations within ${timeoutMs}ms`);
}

async function main(): Promise<void> {
  const started = Date.now();
  console.log("=== Gate 2 (AXL) spike ===");
  resetState();

  // Pre-flight: AXL mesh up?
  const coordinator = new AxlClient({ apiUrl: WATCHDOGS[0]!.axl });
  const coordinatorPk = await coordinator.myPublicKey();
  console.log(`coordinator AXL pk=${coordinatorPk.slice(0, 16)}… via ${WATCHDOGS[0]!.axl}`);

  for (const w of WATCHDOGS) {
    const pk = await new AxlClient({ apiUrl: w.axl }).myPublicKey();
    console.log(`  ${w.id} axl-node pk=${pk.slice(0, 16)}…`);
  }

  // Boot anvil
  const anvil = startProc("anvil", "anvil", ["--host", "127.0.0.1", "--block-time", "2"]);
  await waitForRpc(RPC_URL);

  const provider = new JsonRpcProvider(RPC_URL);
  const deployer = new Wallet(DEPLOYER_PK, provider);
  const alice    = new Wallet(ALICE_PK, provider);

  // Deploy
  const qF = new ContractFactory(abi("WatchdogQuorum"),    bytecode("WatchdogQuorum"),    deployer);
  const nF = new ContractFactory(abi("Agent911PolicyNFT"), bytecode("Agent911PolicyNFT"), deployer);
  const mF = new ContractFactory(abi("MockERC20"),         bytecode("MockERC20"),         deployer);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const quorum = (await (await qF.deploy()).waitForDeployment()) as any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const nft    = (await (await nF.deploy()).waitForDeployment()) as any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const usdc   = (await (await mF.deploy("USD Coin", "USDC", 6)).waitForDeployment()) as any;
  const vF = new ContractFactory(abi("Agent911Vault"), bytecode("Agent911Vault"), deployer);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const vault  = (await (await vF.deploy(await quorum.getAddress(), await nft.getAddress())).waitForDeployment()) as any;

  const quorumAddr = await quorum.getAddress();
  const nftAddr    = await nft.getAddress();
  const vaultAddr  = await vault.getAddress();
  const usdcAddr   = await usdc.getAddress();

  console.log(`  quorum=${quorumAddr} nft=${nftAddr} vault=${vaultAddr} usdc=${usdcAddr}`);

  // Mint policy NFT to Alice, bind, register quorum
  await (await new Contract(nftAddr, abi("Agent911PolicyNFT"), deployer)
    .mintPolicy(alice.address, "ipfs://spike/runbook.json", RUNBOOK_HASH, SAFE_ADDR)).wait();
  await (await new Contract(vaultAddr, abi("Agent911Vault"), alice).bindPolicy(POLICY_ID, 1n)).wait();
  await (await new Contract(quorumAddr, abi("WatchdogQuorum"), deployer).registerPolicy(
    POLICY_ID, vaultAddr, RUNBOOK_HASH,
    WATCHDOGS.map(w => new Wallet(w.pk).address),
    2, 30, 0,
  )).wait();

  // Seed vault with 10k USDC
  const amt = parseUnits("10000", 6);
  await (await new Contract(usdcAddr, abi("MockERC20"), deployer).mint(alice.address, amt)).wait();
  await (await new Contract(usdcAddr, abi("MockERC20"), alice).approve(vaultAddr, amt)).wait();
  await (await new Contract(vaultAddr, abi("Agent911Vault"), alice).deposit(usdcAddr, amt)).wait();
  console.log(`  vault has ${await usdc.balanceOf(vaultAddr)} mUSDC`);

  const chainId = Number((await provider.getNetwork()).chainId);

  // Launch main-agent
  const mainAgent = startProc("main-agent", "tsx", [
    "agents/main-agent.ts",
    "--agent-id", "main.agent911.eth",
    "--heartbeat-path", HEARTBEAT_PATH,
    "--interval-ms", "1000",
  ]);

  // Launch 3 watchdogs, each bound to its own AXL node
  const watchdogProcs = WATCHDOGS.map((w) =>
    startProc(w.id, "tsx", [
      "agents/watchdog-axl.ts",
      "--watchdog-id",         w.id,
      "--private-key",         w.pk,
      "--heartbeat-path",      HEARTBEAT_PATH,
      "--policy-id",           POLICY_ID,
      "--runbook-hash",        RUNBOOK_HASH,
      "--verifying-contract",  quorumAddr,
      "--chain-id",            String(chainId),
      "--poll-ms",             "250",
      "--threshold-ms",        "4000",
      "--expiry-secs",         "300",
      "--axl-api-url",         w.axl,
      "--coordinator-peer-id", coordinatorPk,
    ])
  );

  await new Promise(r => setTimeout(r, 3000));

  console.log("\n============================");
  console.log("[spike-axl] KILL -9 main-agent");
  console.log("============================\n");
  const killT0 = Date.now();
  killGroup(mainAgent, "SIGKILL");

  // Collect 3 attestations via AXL
  const atts = await collectAttestations(coordinator, 3, 25_000);
  console.log(`[spike-axl] 3/3 attestations collected via AXL in ${Date.now() - killT0}ms`);

  const txConfirm = await new Contract(quorumAddr, abi("WatchdogQuorum"), deployer)
    .confirmFailure(POLICY_ID, atts.map(a => ({ observedAt: a.observedAt, expiry: a.expiry, signature: a.signature })));
  await txConfirm.wait();
  const killToConfirmed = Date.now() - killT0;
  console.log(`[spike-axl] kill -> FailureConfirmed = ${killToConfirmed}ms`);

  const txRescue = await new Contract(vaultAddr, abi("Agent911Vault"), deployer).rescue(POLICY_ID, usdcAddr);
  await txRescue.wait();
  const killToSafe = Date.now() - killT0;

  const safeBal     = await usdc.balanceOf(SAFE_ADDR);
  const vaultAfter  = await usdc.balanceOf(vaultAddr);
  if (safeBal !== amt || vaultAfter !== 0n) throw new Error(`rescue failed safe=${safeBal} vault=${vaultAfter}`);

  console.log("\n=== Gate 2 (AXL) PASSED ===");
  console.log(`kill -> FailureConfirmed (via AXL): ${killToConfirmed}ms`);
  console.log(`kill -> safe                     : ${killToSafe}ms`);
  console.log(`total spike runtime              : ${Date.now() - started}ms`);

  for (const p of watchdogProcs) killGroup(p, "SIGTERM");
  killGroup(anvil, "SIGTERM");
  await new Promise(r => setTimeout(r, 500));
  process.exit(0);
}

main().catch((err: unknown) => {
  console.error("[spike-axl] FAILED:", err);
  process.exit(1);
});
