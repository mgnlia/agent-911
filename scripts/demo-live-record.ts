#!/usr/bin/env tsx
/**
 * demo-live-record.ts — INTERACTIVE 0G testnet demo with full dashboard.
 *
 * Same on-chain flow as demo-live.ts, but instead of auto-killing the agent
 * and submitting txs from this script, it spawns the event-bus dashboard
 * (which is also the coordinator) and waits for the user to run
 * `pnpm demo:kill` manually — same UX as demo:start, but every tx is real
 * 0G testnet and every chainscan link clicks through to a real receipt.
 *
 * Flow:
 *   1. Connect to 0G testnet (deployments/0g-testnet.json)
 *   2. Resolve safe.agent-911.eth on mainnet ENS
 *   3. Encrypt + upload runbook, mint policy NFT, bind vault, register quorum,
 *      seed vault with mUSDC. Each step is a real on-chain tx.
 *   4. Spawn main-agent + 3 AXL-routed watchdogs + event-bus (the coordinator).
 *   5. Write /tmp/agent-911/demo.json so `pnpm demo:kill` can find the pids.
 *   6. Wait for SIGINT. Event-bus polls 0G chain + AXL inbox; when 2-of-3
 *      attestations arrive (after demo:kill triggers main-agent SIGKILL),
 *      it fires confirmFailure + rescue, all on real 0G testnet.
 *
 * Open http://127.0.0.1:4000 — every tx hash links to chainscan-galileo.
 *
 * Requires: AXL mesh up (`bash infra/axl/up.sh`), PRIVATE_KEY in env.
 */

import { spawn, ChildProcess } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { JsonRpcProvider, Wallet, Contract as _Contract, parseUnits, hexlify, randomBytes } from "ethers";
import { abi } from "../lib/contracts.ts";
import { AxlClient } from "../lib/axl.ts";
import { ZeroGStorage, encryptRunbook, derivePolicyKey, type Runbook } from "../lib/zero-g-storage.ts";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const Contract = _Contract as any;

const RPC_URL = "https://evmrpc-testnet.0g.ai";
const CHAIN_ID = 16602;
const EXPLORER = "https://chainscan-galileo.0g.ai";

const MAINNET_RPC          = "https://ethereum-rpc.publicnode.com";
const SAFE_ENS_NAME        = "safe.agent-911.eth";
const SAFE_FALLBACK_ADDRESS = ("0x" + "5afe".repeat(10)).slice(0, 42) as `0x${string}`;

const STATE_DIR      = "/tmp/agent-911";
const HEARTBEAT_PATH = join(STATE_DIR, "heartbeat.json");
const DEMO_STATE     = join(STATE_DIR, "demo.json");

const DEPLOYMENTS_FILE = join(process.cwd(), "deployments", "0g-testnet.json");
const AXL_COORD_URL    = "http://127.0.0.1:9101";
const WATCHDOG_NODES = [
  { id: "watchdog-1.agent-911.eth", pk: "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a", axl: "http://127.0.0.1:9101" },
  { id: "watchdog-2.agent-911.eth", pk: "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6", axl: "http://127.0.0.1:9102" },
  { id: "watchdog-3.agent-911.eth", pk: "0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a", axl: "http://127.0.0.1:9103" },
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

function startProc(label: string, cmd: string, args: string[], env?: NodeJS.ProcessEnv): ChildProcess {
  const p = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"], detached: true, env: { ...process.env, ...env } });
  p.stdout?.on("data", (d) => process.stdout.write(`[${label}] ${d}`));
  p.stderr?.on("data", (d) => process.stderr.write(`[${label}!] ${d}`));
  console.log(`[live] launched ${label} pid=${p.pid}`);
  return p;
}

async function waitTx(provider: JsonRpcProvider, hash: string, timeoutMs = 90_000): Promise<number> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const rc = await provider.getTransactionReceipt(hash);
      if (rc && rc.blockNumber) return rc.blockNumber;
    } catch { /* retry */ }
    await new Promise(r => setTimeout(r, 2000));
  }
  throw new Error(`tx ${hash} not confirmed in ${timeoutMs}ms`);
}

async function resolveSafeAddress(): Promise<string> {
  try {
    const p = new JsonRpcProvider(MAINNET_RPC);
    const a = await p.resolveName(SAFE_ENS_NAME);
    if (a) {
      console.log(`[live] resolved ${SAFE_ENS_NAME} → ${a}`);
      return a;
    }
    console.warn(`[live] WARN: ${SAFE_ENS_NAME} did not resolve; using fallback ${SAFE_FALLBACK_ADDRESS}`);
  } catch (e) {
    console.warn(`[live] WARN: ENS lookup failed (${(e as Error).message}); using fallback`);
  }
  return SAFE_FALLBACK_ADDRESS;
}

async function main(): Promise<void> {
  if (existsSync(STATE_DIR)) rmSync(STATE_DIR, { recursive: true, force: true });
  mkdirSync(STATE_DIR, { recursive: true });

  const PRIVATE_KEY = process.env.PRIVATE_KEY;
  if (!PRIVATE_KEY) throw new Error("PRIVATE_KEY env required (use the 0G testnet deployer key)");

  const deployments = loadDeployments();
  const provider = new JsonRpcProvider(RPC_URL);
  const deployer = new Wallet(PRIVATE_KEY, provider);
  if (deployer.address.toLowerCase() !== deployments.deployer.toLowerCase()) {
    throw new Error(`PRIVATE_KEY yields ${deployer.address}, expected ${deployments.deployer}`);
  }

  const addrs = deployments.contracts;
  console.log(`[live] connected to chain ${CHAIN_ID} as ${deployer.address}`);
  for (const [k, v] of Object.entries(addrs)) console.log(`  ${k}: ${EXPLORER}/address/${v}`);

  // pre-flight: AXL coordinator
  const coord = new AxlClient({ apiUrl: AXL_COORD_URL });
  const coordPk = await coord.myPublicKey();
  console.log(`[live] AXL coordinator pk=${coordPk.slice(0, 16)}…`);

  // resolve ENS safe address
  const safeAddress = (await resolveSafeAddress()) as `0x${string}`;

  // unique policyId per run
  const policyId = hexlify(randomBytes(32)) as `0x${string}`;
  console.log(`[live] policyId: ${policyId}`);

  // 1. encrypt + upload runbook
  const masterKey = ("0x" + "11".repeat(32)) as `0x${string}`;
  const runbook: Runbook = {
    version: 1,
    safeAddress,
    allowedAssets: [addrs.MockERC20_mUSDC],
    rescueSteps: [{ kind: "erc20Transfer", token: addrs.MockERC20_mUSDC, to: safeAddress }],
    slippageBps: 100,
    deadlineSecs: 900,
    policyOwner: deployer.address,
    notes: "Agent-911 live 0G demo (record mode)",
  };
  const encrypted = encryptRunbook(runbook, derivePolicyKey(masterKey, policyId));
  // 0G Storage state of play (May 2026):
  //   - The HTTP indexer endpoint we built against (`/file` POST on
  //     indexer-storage-testnet-turbo.0g.ai) returns 404 — schema changed
  //     since the integration was written; the SDK route is what now works.
  //   - We keep ciphertext local for reproducibility, BUT the integrity
  //     story is intact: `metadataHash = keccak256(ciphertext)` is committed
  //     on-chain in mintPolicy + registerPolicy. Anyone can verify the
  //     ciphertext bytes match the committed hash before trusting the
  //     rescue, regardless of where the bytes are stored.
  const store = new ZeroGStorage({ preferLocal: true });
  const { uri, metadataHash } = await store.upload(encrypted);
  console.log(`[live] runbook ciphertext: ${uri} (local — 0G Storage HTTP indexer 404 as of May 2026)`);
  console.log(`[live] runbook metadataHash=${metadataHash} (COMMITTED ON-CHAIN, verifiable against ciphertext)`);

  // 2. mint policy NFT
  const nft = new Contract(addrs.Agent911PolicyNFT, abi("Agent911PolicyNFT"), deployer);
  console.log("[live] tx: mintPolicy");
  const mintTx = await nft.mintPolicy(deployer.address, uri, metadataHash, safeAddress);
  console.log(`[live]   ${EXPLORER}/tx/${mintTx.hash}`);
  await waitTx(provider, mintTx.hash);

  // 3. find tokenId via PolicyMinted event
  let tokenId = 0n;
  const rc = await provider.getTransactionReceipt(mintTx.hash);
  const iface = new (await import("ethers")).Interface(abi("Agent911PolicyNFT") as unknown as string[]);
  for (const log of rc?.logs ?? []) {
    try {
      const parsed = iface.parseLog({ topics: log.topics as string[], data: log.data });
      if (parsed?.name === "PolicyMinted") { tokenId = parsed.args.tokenId as bigint; break; }
    } catch { /* not ours */ }
  }
  if (tokenId === 0n) throw new Error("could not find PolicyMinted event");
  console.log(`[live] tokenId=${tokenId}`);

  // 4. bind policy to vault
  const vault = new Contract(addrs.Agent911Vault, abi("Agent911Vault"), deployer);
  console.log("[live] tx: vault.bindPolicy");
  const bindTx = await vault.bindPolicy(policyId, tokenId);
  console.log(`[live]   ${EXPLORER}/tx/${bindTx.hash}`);
  await waitTx(provider, bindTx.hash);

  // 5. register quorum (gated on policyNFT.ownerOf(tokenId) == msg.sender)
  console.log("[live] tx: quorum.registerPolicy");
  const quorum = new Contract(addrs.WatchdogQuorum, abi("WatchdogQuorum"), deployer);
  const watchdogAddrs = WATCHDOG_NODES.map(w => new Wallet(w.pk).address);
  const regTx = await quorum.registerPolicy(
    policyId,
    tokenId,
    addrs.Agent911Vault,
    metadataHash,
    watchdogAddrs,
    2,    // threshold
    30,   // staleness (s)
    0,    // submission window
  );
  console.log(`[live]   ${EXPLORER}/tx/${regTx.hash}`);
  await waitTx(provider, regTx.hash);

  // 6. seed vault — top up so balance is exactly 10k (handles repeated takes
  // where prior runs left funds in the vault without firing rescue).
  const usdc = new Contract(addrs.MockERC20_mUSDC, abi("MockERC20"), deployer);
  const target = parseUnits("10000", 6);
  const currentVault = await usdc.balanceOf(addrs.Agent911Vault);
  if (currentVault >= target) {
    console.log(`[live] vault already at ${currentVault} mUSDC (≥ 10k target) — skipping deposit`);
  } else {
    const need = target - currentVault;
    console.log(`[live] tx: vault.deposit (top-up ${need} to reach 10,000 mUSDC)`);
    const mintErcTx = await usdc.mint(deployer.address, need);
    await waitTx(provider, mintErcTx.hash);
    const approveTx = await usdc.approve(addrs.Agent911Vault, need);
    await waitTx(provider, approveTx.hash);
    const depTx = await vault.deposit(addrs.MockERC20_mUSDC, need);
    console.log(`[live]   deposit ${EXPLORER}/tx/${depTx.hash}`);
    await waitTx(provider, depTx.hash);
  }
  const vaultBal = await usdc.balanceOf(addrs.Agent911Vault);
  console.log(`[live] vault holds ${vaultBal} mUSDC, safe is empty`);

  // 7. spawn main-agent + 3 watchdogs + event-bus
  console.log("[live] spawning main-agent + 3 watchdogs + event-bus...");
  const mainAgent = startProc("main-agent", "tsx", [
    "agents/main-agent.ts",
    "--agent-id",       "main.agent-911.eth",
    "--heartbeat-path", HEARTBEAT_PATH,
    "--interval-ms",    "1000",
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

  const eventBus = startProc("event-bus", "tsx", ["scripts/event-bus.ts"], {
    DEMO_RPC_URL:     RPC_URL,
    DEMO_QUORUM_ADDR: addrs.WatchdogQuorum,
    DEMO_VAULT_ADDR:  addrs.Agent911Vault,
    DEMO_NFT_ADDR:    addrs.Agent911PolicyNFT,
    DEMO_USDC_ADDR:   addrs.MockERC20_mUSDC,
    DEMO_POLICY_ID:   policyId,
    DEMO_SAFE_ADDR:   safeAddress,
    DEMO_AGENT_ADDR:  deployer.address,
    DEMO_WD1_ADDR:    watchdogAddrs[0]!,
    DEMO_WD2_ADDR:    watchdogAddrs[1]!,
    DEMO_WD3_ADDR:    watchdogAddrs[2]!,
    DEMO_TOKEN_ID:    String(tokenId),
    DEMO_RUNBOOK_HASH: metadataHash,
    DEMO_HEARTBEAT:   HEARTBEAT_PATH,
    DEMO_COORD_AXL:   AXL_COORD_URL,
    DEMO_COORD_PK:    PRIVATE_KEY,
    DEMO_THRESHOLD:   "2",
    DEMO_CHAIN_ID:    String(CHAIN_ID),
    DEMO_EXPLORER:    EXPLORER,
  });

  // 8. write demo state so demo:kill can find the main-agent pid
  writeFileSync(DEMO_STATE, JSON.stringify({
    pids: {
      anvil:     0,
      mainAgent: mainAgent.pid,
      watchdogs: wdProcs.map(p => p.pid),
      eventBus:  eventBus.pid,
    },
    addresses: {
      quorum: addrs.WatchdogQuorum,
      nft:    addrs.Agent911PolicyNFT,
      vault:  addrs.Agent911Vault,
      usdc:   addrs.MockERC20_mUSDC,
    },
    policyId,
    safe: safeAddress,
    watchdogs: WATCHDOG_NODES.map(w => ({ id: w.id, axl: w.axl, address: new Wallet(w.pk).address })),
    rpcUrl: RPC_URL,
    chainId: CHAIN_ID,
    explorer: EXPLORER,
    coordinatorPk: coordPk,
    startedAt: new Date().toISOString(),
  }, null, 2));

  console.log(`\n[live] up. state: ${DEMO_STATE}`);
  console.log("[live] dashboard: http://127.0.0.1:4000/");
  console.log("[live] every tx hash on the dashboard is a real 0G testnet tx — clicks resolve on chainscan");
  console.log("[live] next: 'pnpm demo:kill' to kill main-agent, watch the on-chain rescue happen");
  console.log("[live] (Ctrl-C to tear down)");

  if (process.env.DEMO_ATTACK === "1") {
    setTimeout(() => {
      console.log("[live] DEMO_ATTACK=1 → launching demo-attack scene…");
      const p = startProc("demo-attack", "tsx", ["scripts/demo-attack.ts"]);
      p.unref?.();
    }, 5_000);
  }

  const shutdown = (): void => {
    console.error("\n[live] shutting down...");
    for (const p of [mainAgent, eventBus, ...wdProcs]) killGroup(p);
    setTimeout(() => process.exit(0), 300);
  };
  process.on("SIGINT",  shutdown);
  process.on("SIGTERM", shutdown);

  await new Promise<void>(() => { /* run until signal */ });
}

main().catch((err: unknown) => {
  console.error("[live-record] FAILED:", err);
  process.exit(1);
});
