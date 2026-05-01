#!/usr/bin/env tsx
/**
 * event-bus.ts — small SSE server for the dashboard.
 *
 * Listens on port 4000 and broadcasts a stream of { type, payload } events:
 *   - heartbeat          — ts, pid, counter, agentId
 *   - agent_dead         — emitted when heartbeat goes stale past threshold
 *   - attestation        — a new watchdog signature was received at coordinator
 *   - failure_confirmed  — WatchdogQuorum emitted FailureConfirmed
 *   - vault_balance      — current vault ERC20 balance
 *   - safe_balance       — current safe ERC20 balance
 *   - rescued            — Agent911Vault.Rescued event
 *
 * It polls a small set of sources:
 *   1. /tmp/agent-911/heartbeat.json file (heartbeat age + counter)
 *   2. AXL node-1 /recv — tees inbound attestations to this SSE stream
 *   3. anvil eth_getLogs for FailureConfirmed + Rescued + vault/safe balances
 *
 * Also serves a single static page at / that renders the tri-pane UI.
 */

import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { JsonRpcProvider, Wallet, Contract as _Contract, id as topicId } from "ethers";
import { abi } from "../lib/contracts.ts";
import { AxlClient } from "../lib/axl.ts";
import { heartbeatAgeMs } from "../lib/heartbeat-bus.ts";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const Contract = _Contract as any;

const PORT = 4000;

const RPC_URL        = process.env.DEMO_RPC_URL   ?? "http://127.0.0.1:8545";
const QUORUM_ADDR    = process.env.DEMO_QUORUM_ADDR ?? "";
const VAULT_ADDR     = process.env.DEMO_VAULT_ADDR  ?? "";
const NFT_ADDR       = process.env.DEMO_NFT_ADDR    ?? "";
const USDC_ADDR      = process.env.DEMO_USDC_ADDR   ?? "";
const POLICY_ID      = (process.env.DEMO_POLICY_ID  ?? "") as `0x${string}`;
const SAFE_ADDR      = process.env.DEMO_SAFE_ADDR   ?? "";
const CHAIN_ID       = parseInt(process.env.DEMO_CHAIN_ID ?? "31337", 10);
const EXPLORER       = process.env.DEMO_EXPLORER ?? "https://chainscan-galileo.0g.ai";
const CHAIN_NAME     = CHAIN_ID === 16602 ? "0G Galileo Testnet" : (CHAIN_ID === 31337 ? "Anvil (local)" : `chain ${CHAIN_ID}`);
const IS_0G          = CHAIN_ID === 16602;
const AGENT_ADDR     = process.env.DEMO_AGENT_ADDR ?? "";
const WD1_ADDR       = process.env.DEMO_WD1_ADDR ?? "";
const WD2_ADDR       = process.env.DEMO_WD2_ADDR ?? "";
const WD3_ADDR       = process.env.DEMO_WD3_ADDR ?? "";
const TOKEN_ID       = process.env.DEMO_TOKEN_ID ?? "";
const RUNBOOK_HASH   = process.env.DEMO_RUNBOOK_HASH ?? "";

function ensLink(label: string, addr: string): string {
  if (!addr) return label;
  return '<a class="ens-link" href="' + EXPLORER + '/address/' + addr + '" target="_blank" rel="noopener" title="' + addr + ' on chainscan">' + label + '</a>';
}
const HEARTBEAT_PATH = process.env.DEMO_HEARTBEAT   ?? "/tmp/agent-911/heartbeat.json";
const COORD_AXL      = process.env.DEMO_COORD_AXL   ?? "http://127.0.0.1:9101";
const COORD_PK       = process.env.DEMO_COORD_PK    ?? "";
const THRESHOLD      = parseInt(process.env.DEMO_THRESHOLD ?? "2", 10);

// --- in-memory broadcast ---
type Client = { res: ServerResponse };
const clients = new Set<Client>();

interface Event {
  type: string;
  payload: Record<string, unknown>;
  ts: number;
}

function broadcast(ev: Event): void {
  const data = `data: ${JSON.stringify(ev)}\n\n`;
  for (const c of clients) {
    try { c.res.write(data); } catch { /* client gone */ }
  }
}

function emit(type: string, payload: Record<string, unknown> = {}): void {
  broadcast({ type, payload, ts: Date.now() });
}

// --- polling loops ---

async function heartbeatLoop(): Promise<void> {
  let lastCounter = -1;
  let dead = false;
  const STALE_MS = 4000;
  while (true) {
    try {
      const age = heartbeatAgeMs(HEARTBEAT_PATH);
      const healthy = age <= STALE_MS;
      if (healthy) {
        try {
          const hb = JSON.parse(readFileSync(HEARTBEAT_PATH, "utf8")) as { counter: number; pid: number; agentId: string };
          if (hb.counter !== lastCounter) {
            lastCounter = hb.counter;
            dead = false;
            emit("heartbeat", { ageMs: age, counter: hb.counter, pid: hb.pid, agentId: hb.agentId });
          }
        } catch { /* race */ }
      } else if (!dead) {
        dead = true;
        emit("agent_dead", { ageMs: age });
      }
    } catch { /* noop */ }
    await new Promise(r => setTimeout(r, 500));
  }
}

interface CollectedAtt {
  watchdogId: string;
  observedAt: bigint;
  expiry: bigint;
  signature: `0x${string}`;
}

async function axlInboxLoop(): Promise<void> {
  const cli = new AxlClient({ apiUrl: COORD_AXL });
  const atts = new Map<string, CollectedAtt>();
  let submitted = false;

  while (true) {
    try {
      const msg = await cli.recvJson<Record<string, unknown>>();
      if (msg && typeof msg.payload === "object" && msg.payload !== null && (msg.payload as { kind?: string }).kind === "Agent911.FailureAttestation") {
        const p = msg.payload as {
          watchdogId: string; observedAt: number; expiry: number;
          signature: `0x${string}`; policyId: `0x${string}`;
        };

        emit("attestation", {
          fromPeer:   msg.fromPeerId.slice(0, 16),
          watchdogId: p.watchdogId,
        });

        if (!atts.has(p.watchdogId) && p.policyId === POLICY_ID) {
          atts.set(p.watchdogId, {
            watchdogId: p.watchdogId,
            observedAt: BigInt(p.observedAt),
            expiry:     BigInt(p.expiry),
            signature:  p.signature,
          });
        }

        if (!submitted && atts.size >= THRESHOLD && COORD_PK && QUORUM_ADDR && VAULT_ADDR && USDC_ADDR) {
          submitted = true;
          try {
            const provider = new JsonRpcProvider(RPC_URL);
            const signer   = new Wallet(COORD_PK, provider);
            const bundle = Array.from(atts.values()).map(a => ({
              observedAt: a.observedAt, expiry: a.expiry, signature: a.signature,
            }));

            const quorum = new Contract(QUORUM_ADDR, abi("WatchdogQuorum"), signer);
            const txC = await quorum.confirmFailure(POLICY_ID, bundle);
            emit("coord_submitting", { step: "confirmFailure", hash: txC.hash });
            await txC.wait();

            const vault = new Contract(VAULT_ADDR, abi("Agent911Vault"), signer);
            const txR = await vault.rescue(POLICY_ID, USDC_ADDR);
            emit("coord_submitting", { step: "rescue", hash: txR.hash });
            await txR.wait();
          } catch (err) {
            emit("coord_error", { error: String(err) });
          }
        }
      }
    } catch { /* axl blip */ }
    await new Promise(r => setTimeout(r, 250));
  }
}

async function chainLoop(): Promise<void> {
  if (!QUORUM_ADDR || !VAULT_ADDR || !USDC_ADDR) return;

  const provider = new JsonRpcProvider(RPC_URL);
  const quorum   = new Contract(QUORUM_ADDR, abi("WatchdogQuorum"),  provider);
  const vault    = new Contract(VAULT_ADDR,  abi("Agent911Vault"),   provider);
  const usdc     = new Contract(USDC_ADDR,   abi("MockERC20"),       provider);

  const failureConfirmedTopic = topicId("FailureConfirmed(bytes32,uint64,address[])");
  const rescuedTopic          = topicId("Rescued(bytes32,address,address,address,uint256)");

  let lastBlock = await provider.getBlockNumber();
  while (true) {
    try {
      const cur = await provider.getBlockNumber();
      if (cur > lastBlock) {
        const logs = await provider.getLogs({
          fromBlock: lastBlock + 1, toBlock: cur,
          address: [QUORUM_ADDR, VAULT_ADDR],
          topics: [[failureConfirmedTopic, rescuedTopic]],
        });
        for (const log of logs) {
          if (log.topics[0] === failureConfirmedTopic) {
            emit("failure_confirmed", { block: log.blockNumber, txHash: log.transactionHash });
          } else if (log.topics[0] === rescuedTopic) {
            emit("rescued", { block: log.blockNumber, txHash: log.transactionHash });
          }
        }
        lastBlock = cur;
      }

      const vb = await usdc.balanceOf(VAULT_ADDR);
      const sb = await usdc.balanceOf(SAFE_ADDR);
      const isFailed = await quorum.isFailed(POLICY_ID);
      emit("chain_state", {
        block: cur,
        vaultBalance: vb.toString(),
        safeBalance: sb.toString(),
        quorumConfirmed: isFailed,
      });
    } catch { /* rpc blip */ }
    await new Promise(r => setTimeout(r, 1000));
  }
}

// --- HTTP server ---
// Plain string concatenation, no external user input reaches innerHTML.
const INDEX_HTML = [
  '<!doctype html>',
  '<html>',
  '<head>',
  '<title>Agent-911 Demo</title>',
  '<meta charset="utf-8" />',
  '<style>',
  ':root { --bg:#0f1115; --fg:#e6e7eb; --muted:#9aa0aa; --dead:#ff4d4d; --live:#5eff8a; --warn:#ffbb33; --panel:#171a21; --accent:#6aa6ff; }',
  'body { margin:0; font-family: ui-monospace,Menlo,Consolas,monospace; background:var(--bg); color:var(--fg); }',
  '.persona { background:#000; color:#fff; padding:14px 24px; font-size:20px; font-weight:700; letter-spacing:0.01em; border-bottom:1px solid #1a1d24; display:flex; flex-wrap:wrap; gap:14px; align-items:baseline; }',
  '.persona .who { color:#fff; }',
  '.persona .at-risk { color:var(--warn); }',
  '.persona .agent { color:var(--accent); font-weight:600; }',
  '.persona .dot { color:#3a3f4a; font-weight:400; }',
  '.app { display:grid; grid-template-columns: 1fr 1fr 1fr; gap:16px; padding:20px; min-height:100vh; }',
  '.panel { background:var(--panel); border-radius:10px; padding:16px; border:1px solid #242935; transition: box-shadow 200ms ease; }',
  'h2 { margin:0 0 12px; font-size:14px; color:var(--muted); letter-spacing:0.1em; text-transform:uppercase; }',
  '.kv { display:flex; justify-content:space-between; padding:4px 0; border-bottom:1px dashed #2a2f3a; font-size:13px; }',
  '.kv b { color:var(--muted); font-weight:normal; }',
  '.dead { color:var(--dead); font-weight:bold; } .live { color:var(--live); font-weight:bold; } .warn { color:var(--warn); } .hex { color:var(--accent); }',
  'a.tx-link { color:var(--accent); text-decoration:underline; cursor:pointer; font-family:monospace; }',
  'a.tx-link:hover { opacity:0.8; color:var(--live); }',
  '.timer { font-size:32px; font-family:monospace; color:var(--accent); }',
  '.log { font-size:11px; color:var(--muted); max-height:300px; overflow:auto; }',
  '.watchdog { padding:8px; background:#20242e; border-radius:6px; margin-bottom:8px; display:flex; gap:10px; align-items:center; flex-wrap:wrap; }',
  '.watchdog .id { font-weight:bold; color:var(--accent); }',
  '.axl-badge { font-size:11px; font-weight:500; background:linear-gradient(90deg,#5eff8a22,#6aa6ff22); border:1px solid #5eff8a55; color:var(--live); padding:3px 8px; border-radius:4px; margin-left:8px; letter-spacing:0.02em; }',
  '.axl-note { font-size:12px; color:var(--muted); margin:6px 0 12px 0; line-height:1.4; }',
  '.axl-note i { color:var(--warn); font-style:italic; }',
  '.axl-port { font-family:monospace; font-size:11px; color:var(--muted); background:#000; padding:2px 6px; border-radius:3px; border:1px solid #333; }',
  '.role-badge { font-size:11px; font-weight:500; background:linear-gradient(90deg,#ffbb3322,#ff4d4d22); border:1px solid #ffbb3355; color:var(--warn); padding:3px 8px; border-radius:4px; margin-left:8px; letter-spacing:0.02em; }',
  '.role-note { font-size:12px; color:var(--muted); margin:6px 0 12px 0; line-height:1.4; }',
  '.role-note b { color:var(--warn); }',
  '.role-tag { font-weight:400; font-size:11px; color:var(--muted); margin-left:4px; }',
  '.chain-strip { background:#0a0c10; padding:10px 24px; border-bottom:1px solid #1a1d24; display:flex; gap:24px; flex-wrap:wrap; align-items:center; font-size:12px; }',
  '.chain-strip .label { color:var(--muted); text-transform:uppercase; letter-spacing:0.05em; font-size:10px; }',
  '.chain-strip .chain-name { color:var(--live); font-weight:bold; font-size:13px; }',
  '.chain-strip .badge-0g { background:#0a3d2a; border:1px solid var(--live); color:var(--live); padding:2px 8px; border-radius:3px; font-weight:bold; }',
  '.chain-strip .block-num { font-family:monospace; color:var(--accent); }',
  '.chain-strip a { color:var(--accent); text-decoration:none; }',
  '.chain-strip a:hover { text-decoration:underline; }',
  '.contracts-footer { padding:14px 24px; background:#0a0c10; border-top:1px solid #1a1d24; font-size:11px; color:var(--muted); }',
  '.contracts-footer .label { text-transform:uppercase; letter-spacing:0.05em; font-size:10px; color:var(--muted); margin-right:12px; }',
  '.contracts-footer a { font-family:monospace; color:var(--accent); text-decoration:none; margin-right:18px; }',
  '.contracts-footer a:hover { color:var(--live); text-decoration:underline; }',
  '.contracts-footer .ctype { color:var(--muted); }',
  '.ens-link { color:inherit; text-decoration:none; border-bottom:1px dashed currentColor; cursor:pointer; }',
  '.ens-link:hover { color:var(--live); border-bottom-style:solid; }',
  '.onchain-badge { background:#0a3d2a; color:var(--live); border:1px solid var(--live); padding:1px 6px; border-radius:3px; font-size:9px; font-weight:bold; letter-spacing:0.05em; margin-left:6px; vertical-align:middle; }',
  '.inft-strip { background:linear-gradient(90deg,#1a0e2e 0%,#0e1a2e 100%); padding:14px 24px; border-bottom:1px solid #2a2f3a; display:flex; gap:18px; flex-wrap:wrap; align-items:center; font-size:13px; }',
  '.inft-strip .label { color:var(--muted); text-transform:uppercase; letter-spacing:0.05em; font-size:10px; }',
  '.inft-strip .erc-badge { background:linear-gradient(90deg,#a855f7,#6aa6ff); color:#fff; padding:3px 10px; border-radius:4px; font-weight:bold; font-size:11px; letter-spacing:0.05em; }',
  '.inft-strip .token-id { font-family:monospace; color:var(--accent); font-weight:bold; font-size:14px; }',
  '.inft-strip .hash-mini { font-family:monospace; color:var(--accent); font-size:12px; }',
  '.inft-strip a { color:var(--accent); }',
  '.inft-strip .arrow { color:var(--muted); font-weight:bold; }',
  '.inft-strip .tagline { color:var(--warn); font-style:italic; font-size:12px; margin-left:auto; }',
  '.stamp { background:#2d2f37; color:var(--live); padding:2px 8px; border-radius:4px; font-size:11px; }',
  '.stamp.pending { color:var(--muted); }',
  '.title { font-size:22px; font-weight:700; color:#fff; margin-bottom:18px; }',
  '.sub { font-size:12px; color:var(--muted); }',
  '#safe-bal { transition: color 200ms ease; }',
  '@keyframes safe-flash { 0% { box-shadow: 0 0 0 0 rgba(255,77,77,0.0); border-color:#242935; } 18% { box-shadow: 0 0 24px 6px rgba(255,77,77,0.55); border-color:var(--dead); } 55% { box-shadow: 0 0 24px 6px rgba(94,255,138,0.55); border-color:var(--live); } 100% { box-shadow: 0 0 0 0 rgba(94,255,138,0.0); border-color:#242935; } }',
  '.panel.flash-rescue { animation: safe-flash 1.2s ease-out 1; }',
  '.attack-card { padding:10px 12px; background:#2a1416; border:1px solid #ff4d4d; border-radius:6px; margin-bottom:8px; color:#ffd9d9; font-size:12px; }',
  '.attack-card .hdr { color:var(--dead); font-weight:bold; text-transform:uppercase; letter-spacing:0.05em; font-size:11px; margin-bottom:4px; }',
  '.attack-card .who { color:#ff8080; word-break:break-all; }',
  '.attack-card .reason { color:#ffd9d9; margin-top:4px; }',
  '</style>',
  '</head>',
  '<body>',
  '<div class="persona">',
  '<span class="who">DeFi treasury agent</span>',
  '<span class="dot">·</span>',
  '<span class="at-risk"><span id="persona-amount">—</span> mUSDC at risk</span>',
  '<span class="dot">·</span>',
  '<span class="agent">' + ensLink('main.agent-911.eth', AGENT_ADDR) + '</span>',
  '</div>',
  '<div class="chain-strip">',
  '<span class="badge-0g">' + (IS_0G ? '0G TESTNET' : CHAIN_NAME.toUpperCase()) + '</span>',
  '<span><span class="label">Chain</span> <span class="chain-name">' + CHAIN_NAME + '</span> <span class="block-num">' + String(CHAIN_ID) + '</span></span>',
  '<span><span class="label">RPC</span> <span class="block-num">' + RPC_URL + '</span></span>',
  '<span><span class="label">Block</span> <span class="block-num" id="block-strip">—</span></span>',
  '<span><span class="label">Mainnet ENS</span> ' + ensLink('safe.agent-911.eth', SAFE_ADDR) + ' → ' + ensLink(SAFE_ADDR ? SAFE_ADDR.slice(0,10) + '…' + SAFE_ADDR.slice(-6) : '—', SAFE_ADDR) + '</span>',
  '</div>',
  '<div class="inft-strip">',
  '<span class="erc-badge">ERC-7857 iNFT</span>',
  '<span><span class="label">Agent911PolicyNFT</span> ' + (NFT_ADDR ? '<a class="ens-link" href="' + EXPLORER + '/address/' + NFT_ADDR + '" target="_blank" rel="noopener">' + NFT_ADDR.slice(0,8) + '…' + NFT_ADDR.slice(-6) + '</a>' : '—') + '</span>',
  '<span><span class="label">tokenId</span> <span class="token-id">#' + (TOKEN_ID || '—') + '</span></span>',
  '<span><span class="label">owner</span> ' + ensLink(AGENT_ADDR ? AGENT_ADDR.slice(0,8) + '…' + AGENT_ADDR.slice(-6) : '—', AGENT_ADDR) + '</span>',
  '<span><span class="label">runbook hash</span> <span class="hash-mini" title="keccak256(encrypted runbook ciphertext) — committed on-chain in mintPolicy()">' + (RUNBOOK_HASH ? RUNBOOK_HASH.slice(0,10) + '…' + RUNBOOK_HASH.slice(-6) : '—') + '</span></span>',
  '<span class="arrow">→</span>',
  '<span><span class="label">→ safe</span> ' + ensLink('safe.agent-911.eth', SAFE_ADDR) + '</span>',
  '<span class="tagline">transfer NFT → rescue redirects</span>',
  '</div>',
  '<div class="app">',
  '<div class="panel">',
  '<h2>The Agent <span class="role-badge">manages the vault →</span></h2>',
  '<div class="kv"><b>name</b><span class="hex" id="agent-id">—</span></div>',
  '<div class="kv"><b>status</b><span id="agent-status">—</span></div>',
  '<div class="kv"><b>heartbeat</b><span id="agent-counter">#0</span></div>',
  '<div class="kv"><b>last seen</b><span id="agent-age">—</span></div>',
  '<div class="kv"><b>KILL TO SAFE</b><span class="timer" id="timer">00:00</span></div>',
  '</div>',
  '<div class="panel">',
  '<h2>Watchdog Quorum <span class="axl-badge">via Gensyn AXL · 2-of-3</span></h2>',
  '<div class="axl-note">Each watchdog on a separate Yggdrasil peer. Same-host = dies with the agent.</div>',
  '<div id="watchdogs">',
  '<div class="watchdog"><span class="id">' + ensLink('watchdog-1.agent-911.eth', WD1_ADDR) + '</span> <span class="axl-port">AXL :9101</span> <span class="stamp pending" data-w="1">pending</span></div>',
  '<div class="watchdog"><span class="id">' + ensLink('watchdog-2.agent-911.eth', WD2_ADDR) + '</span> <span class="axl-port">AXL :9102</span> <span class="stamp pending" data-w="2">pending</span></div>',
  '<div class="watchdog"><span class="id">' + ensLink('watchdog-3.agent-911.eth', WD3_ADDR) + '</span> <span class="axl-port">AXL :9103</span> <span class="stamp pending" data-w="3">pending</span></div>',
  '</div>',
  '<div id="rejected-attestations"></div>',
  '<div class="kv"><b>quorum<span class="onchain-badge">0G</span></b><span id="quorum-state">pending</span></div>',
  '<div class="kv"><b>failure confirmed tx<span class="onchain-badge">0G</span></b><span class="hex" id="confirm-tx">—</span></div>',
  '</div>',
  '<div class="panel" id="safe-panel">',
  '<h2>Funds <span class="role-badge">vault → safe on rescue</span></h2>',
  '<div class="kv"><b>vault<span class="onchain-badge">0G</span></b><span id="vault-bal">—</span></div>',
  '<div class="kv"><b>safe<span class="onchain-badge">0G</span></b><span class="live" id="safe-bal">—</span></div>',
  '<div class="kv"><b>rescue tx<span class="onchain-badge">0G</span></b><span class="hex" id="rescue-tx">—</span></div>',
  '<div class="kv"><b>block</b><span id="block">—</span></div>',
  '</div>',
  '</div>',
  '<div style="padding:0 20px 20px 20px;">',
  '<div class="panel">',
  '<h2>Live Event Log</h2>',
  '<div class="log" id="log"></div>',
  '</div>',
  '</div>',
  '<div class="contracts-footer">',
  '<span class="label">0G Testnet contracts</span>',
  '<a href="' + EXPLORER + '/address/' + QUORUM_ADDR + '" target="_blank" rel="noopener" title="WatchdogQuorum"><span class="ctype">Quorum:</span> ' + (QUORUM_ADDR ? QUORUM_ADDR.slice(0,8) + '…' + QUORUM_ADDR.slice(-6) : '—') + '</a>',
  '<a href="' + EXPLORER + '/address/' + NFT_ADDR + '" target="_blank" rel="noopener" title="Agent911PolicyNFT"><span class="ctype">PolicyNFT:</span> ' + (NFT_ADDR ? NFT_ADDR.slice(0,8) + '…' + NFT_ADDR.slice(-6) : '—') + '</a>',
  '<a href="' + EXPLORER + '/address/' + VAULT_ADDR + '" target="_blank" rel="noopener" title="Agent911Vault"><span class="ctype">Vault:</span> ' + (VAULT_ADDR ? VAULT_ADDR.slice(0,8) + '…' + VAULT_ADDR.slice(-6) : '—') + '</a>',
  '<a href="' + EXPLORER + '/address/' + USDC_ADDR + '" target="_blank" rel="noopener" title="MockERC20"><span class="ctype">mUSDC:</span> ' + (USDC_ADDR ? USDC_ADDR.slice(0,8) + '…' + USDC_ADDR.slice(-6) : '—') + '</a>',
  '<span><span class="ctype">policyId:</span> <span class="hex">' + (POLICY_ID ? POLICY_ID.slice(0,10) + '…' + POLICY_ID.slice(-6) : '—') + '</span></span>',
  '</div>',
  '<script>',
  'const $ = (id) => document.getElementById(id);',
  'const log = (msg) => { const el = $("log"); const line = document.createElement("div"); line.textContent = new Date().toISOString().slice(11,19) + "  " + msg; el.prepend(line); while (el.childNodes.length > 100) el.removeChild(el.lastChild); };',
  'let killTime = null; let tickT = null;',
  'function fmtUsdcNum(n) { return n.toLocaleString(undefined,{minimumFractionDigits:2, maximumFractionDigits:2}) + " mUSDC"; }',
  'function weiToNum(wei) { if (!wei) return 0; try { return Number(BigInt(wei)) / 1e6; } catch(e) { return 0; } }',
  '// per-element tween state; cancels an in-flight tween if a new target arrives',
  'const tweenState = {};',
  'function tweenUsdc(id, targetWei, durMs) {',
  '  const el = $(id); if (!el) return;',
  '  const target = weiToNum(targetWei);',
  '  const prev = tweenState[id];',
  '  if (prev) cancelAnimationFrame(prev.raf);',
  '  const start = (prev && typeof prev.value === "number") ? prev.value : target; // first paint = snap',
  '  if (!prev || start === target) { el.textContent = fmtUsdcNum(target); tweenState[id] = { value: target, raf: 0 }; return; }',
  '  const t0 = performance.now();',
  '  const dur = durMs || 800;',
  '  const step = (t) => {',
  '    const k = Math.min(1, (t - t0) / dur);',
  '    // ease-out cubic',
  '    const e = 1 - Math.pow(1 - k, 3);',
  '    const cur = start + (target - start) * e;',
  '    el.textContent = fmtUsdcNum(cur);',
  '    if (k < 1) { tweenState[id].raf = requestAnimationFrame(step); }',
  '    else { tweenState[id].value = target; tweenState[id].raf = 0; }',
  '  };',
  '  tweenState[id] = { value: start, raf: requestAnimationFrame(step) };',
  '}',
  'function flashSafePanel() {',
  '  const p = $("safe-panel"); if (!p) return;',
  '  p.classList.remove("flash-rescue");',
  '  // force reflow so animation can replay',
  '  void p.offsetWidth;',
  '  p.classList.add("flash-rescue");',
  '}',
  'function startTimer() { if (killTime) return; killTime = Date.now(); tickT = setInterval(()=> { const d = Math.floor((Date.now() - killTime)/1000); const m = String(Math.floor(d/60)).padStart(2,"0"); const s = String(d%60).padStart(2,"0"); $("timer").textContent = m + ":" + s; }, 500); }',
  'function stopTimer() { if (tickT) clearInterval(tickT); }',
  'function matchWatchdog(id) { if (id.startsWith("watchdog-1")) return "1"; if (id.startsWith("watchdog-2")) return "2"; if (id.startsWith("watchdog-3")) return "3"; return null; }',
  'function setText(id, txt) { const el = $(id); if (el) el.textContent = txt; }',
  'function setTxLink(id, hash) {',
  '  const el = $(id); if (!el) return;',
  '  while (el.firstChild) el.removeChild(el.firstChild);',
  '  if (!hash) { el.textContent = "—"; return; }',
  '  const a = document.createElement("a");',
  '  a.href = "https://chainscan-galileo.0g.ai/tx/" + hash;',
  '  a.target = "_blank";',
  '  a.rel = "noopener";',
  '  a.className = "tx-link";',
  '  a.title = "open on 0G chainscan";',
  '  a.textContent = hash.slice(0, 10) + "…" + hash.slice(-6);',
  '  el.appendChild(a);',
  '}',
  'function setClass(id, cls) { const el = $(id); if (el) el.className = cls; }',
  'function setQuorumConfirmed() { const el = $("quorum-state"); if (!el) return; el.textContent = ""; const s = document.createElement("span"); s.className = "live"; s.textContent = "CONFIRMED"; el.appendChild(s); }',
  'function shortAddr(a) { if (!a || a.length < 10) return a || "?"; return a.slice(0,6) + "…" + a.slice(-4); }',
  'function renderRejectedAttestation(attacker, reason) {',
  '  const host = $("rejected-attestations"); if (!host) return;',
  '  const card = document.createElement("div");',
  '  card.className = "attack-card";',
  '  const hdr = document.createElement("div");',
  '  hdr.className = "hdr"; hdr.textContent = "Rejected attestation";',
  '  const who = document.createElement("div");',
  '  who.className = "who"; who.textContent = "from " + shortAddr(attacker || "0x") + " (not a registered watchdog)";',
  '  const why = document.createElement("div");',
  '  why.className = "reason"; why.textContent = "on-chain revert: " + (reason || "unauthorized signer");',
  '  card.appendChild(hdr); card.appendChild(who); card.appendChild(why);',
  '  host.prepend(card);',
  '  while (host.childNodes.length > 3) host.removeChild(host.lastChild);',
  '}',
  'const src = new EventSource("/events");',
  'src.onmessage = (ev) => {',
  '  const { type, payload } = JSON.parse(ev.data);',
  '  if (type === "heartbeat") { setText("agent-id", payload.agentId); setText("agent-status", "LIVE"); setClass("agent-status", "live"); setText("agent-counter", "#" + payload.counter); setText("agent-age", Math.round(payload.ageMs) + " ms"); }',
  '  else if (type === "agent_dead") { setText("agent-status", "OFFLINE"); setClass("agent-status", "dead"); startTimer(); log("main-agent OFFLINE (heartbeat stale " + Math.round(payload.ageMs) + "ms)"); }',
  '  else if (type === "attestation") { const n = matchWatchdog(payload.watchdogId); if (n) { const s = document.querySelector(\'[data-w="\' + n + \'"]\'); if (s) { s.textContent = "SIGNED"; s.classList.remove("pending"); } } log("attestation from " + payload.watchdogId + " (axl peer " + payload.fromPeer + ")"); }',
  '  else if (type === "failure_confirmed") { setQuorumConfirmed(); setTxLink("confirm-tx", payload.txHash); log("FailureConfirmed at block " + payload.block); }',
  '  else if (type === "rescued") { setTxLink("rescue-tx", payload.txHash); stopTimer(); log("RESCUED at block " + payload.block); }',
  '  else if (type === "chain_state") {',
  '    const prevSafe = (tweenState["safe-bal"] && typeof tweenState["safe-bal"].value === "number") ? tweenState["safe-bal"].value : null;',
  '    const newSafe = weiToNum(payload.safeBalance);',
  '    tweenUsdc("vault-bal", payload.vaultBalance, 800);',
  '    tweenUsdc("safe-bal",  payload.safeBalance, 800);',
  '    setText("block", String(payload.block));',
  '    setText("block-strip", "#" + payload.block);',
  '    // Update persona "at risk" amount: when vault > 0 show vault, when vault = 0 (post-rescue) show what landed in safe.',
  '    const vNum = weiToNum(payload.vaultBalance);',
  '    const sNum = weiToNum(payload.safeBalance);',
  '    const display = vNum > 0 ? vNum : sNum;',
  '    if (display > 0) setText("persona-amount", "$" + Math.round(display).toLocaleString());',
  '    if (prevSafe !== null && Math.abs(newSafe - prevSafe) > 0.0001) flashSafePanel();',
  '  }',
  '  else if (type === "attack-rejected") { renderRejectedAttestation(payload.attacker, payload.reason); log("ATTACK REJECTED — " + shortAddr(payload.attacker) + " — " + (payload.reason || "")); }',
  '};',
  '</script>',
  '</body>',
  '</html>',
].join("\n");

function handle(req: IncomingMessage, res: ServerResponse): void {
  if (req.url === "/" || req.url === "/index.html") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(INDEX_HTML);
    return;
  }
  if (req.url === "/events") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
      "Access-Control-Allow-Origin": "*",
    });
    res.write(`: connected\n\n`);
    const client: Client = { res };
    clients.add(client);
    req.on("close", () => clients.delete(client));
    return;
  }
  if (req.url === "/emit" && req.method === "POST") {
    // External scripts (e.g. demo-attack.ts) push synthetic events into the SSE
    // stream so the dashboard can reflect side-band actions like rejected
    // attestations. Trusted localhost-only — there's no auth here.
    let body = "";
    req.on("data", (chunk: Buffer) => { body += chunk.toString("utf8"); if (body.length > 64 * 1024) req.destroy(); });
    req.on("end", () => {
      try {
        const ev = JSON.parse(body) as { type?: string; payload?: Record<string, unknown> };
        if (!ev || typeof ev.type !== "string") {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: "missing type" }));
          return;
        }
        emit(ev.type, ev.payload ?? {});
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      } catch (err) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: String(err) }));
      }
    });
    return;
  }
  res.writeHead(404);
  res.end();
}

const server = createServer(handle);
server.listen(PORT, () => {
  console.log(`[event-bus] listening on :${PORT}`);
  heartbeatLoop();
  axlInboxLoop();
  chainLoop();
});
