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
import { JsonRpcProvider, Contract as _Contract, id as topicId } from "ethers";
import { abi } from "../lib/contracts.ts";
import { AxlClient } from "../lib/axl.ts";
import { heartbeatAgeMs } from "../lib/heartbeat-bus.ts";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const Contract = _Contract as any;

const PORT = 4000;

const RPC_URL        = process.env.DEMO_RPC_URL   ?? "http://127.0.0.1:8545";
const QUORUM_ADDR    = process.env.DEMO_QUORUM_ADDR ?? "";
const VAULT_ADDR     = process.env.DEMO_VAULT_ADDR  ?? "";
const USDC_ADDR      = process.env.DEMO_USDC_ADDR   ?? "";
const POLICY_ID      = (process.env.DEMO_POLICY_ID  ?? "") as `0x${string}`;
const SAFE_ADDR      = process.env.DEMO_SAFE_ADDR   ?? "";
const HEARTBEAT_PATH = process.env.DEMO_HEARTBEAT   ?? "/tmp/agent-911/heartbeat.json";
const COORD_AXL      = process.env.DEMO_COORD_AXL   ?? "http://127.0.0.1:9101";

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

async function axlInboxLoop(): Promise<void> {
  const cli = new AxlClient({ apiUrl: COORD_AXL });
  while (true) {
    try {
      const msg = await cli.recvJson<Record<string, unknown>>();
      if (msg && typeof msg.payload === "object" && msg.payload !== null && (msg.payload as { kind?: string }).kind === "Agent911.FailureAttestation") {
        emit("attestation", {
          fromPeer: msg.fromPeerId.slice(0, 16),
          watchdogId: (msg.payload as { watchdogId: string }).watchdogId,
        });
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
  '.app { display:grid; grid-template-columns: 1fr 1fr 1fr; gap:16px; padding:20px; min-height:100vh; }',
  '.panel { background:var(--panel); border-radius:10px; padding:16px; border:1px solid #242935; }',
  'h2 { margin:0 0 12px; font-size:14px; color:var(--muted); letter-spacing:0.1em; text-transform:uppercase; }',
  '.kv { display:flex; justify-content:space-between; padding:4px 0; border-bottom:1px dashed #2a2f3a; font-size:13px; }',
  '.kv b { color:var(--muted); font-weight:normal; }',
  '.dead { color:var(--dead); font-weight:bold; } .live { color:var(--live); font-weight:bold; } .warn { color:var(--warn); } .hex { color:var(--accent); }',
  '.timer { font-size:32px; font-family:monospace; color:var(--accent); }',
  '.log { font-size:11px; color:var(--muted); max-height:300px; overflow:auto; }',
  '.watchdog { padding:8px; background:#20242e; border-radius:6px; margin-bottom:8px; }',
  '.watchdog .id { font-weight:bold; color:var(--accent); }',
  '.stamp { background:#2d2f37; color:var(--live); padding:2px 8px; border-radius:4px; font-size:11px; }',
  '.stamp.pending { color:var(--muted); }',
  '.title { font-size:22px; font-weight:700; color:#fff; margin-bottom:18px; }',
  '.sub { font-size:12px; color:var(--muted); }',
  '</style>',
  '</head>',
  '<body>',
  '<div style="padding:20px 20px 0 20px;">',
  '<div class="title">Agent-911 — Autonomous Agent Rescue Layer</div>',
  '<div class="sub">Kill the main agent, watch the watchdog quorum save the funds. Heartbeat + AXL mesh + 0G + ERC-7857 policy NFT.</div>',
  '</div>',
  '<div class="app">',
  '<div class="panel">',
  '<h2>The Agent</h2>',
  '<div class="kv"><b>name</b><span class="hex" id="agent-id">—</span></div>',
  '<div class="kv"><b>status</b><span id="agent-status">—</span></div>',
  '<div class="kv"><b>heartbeat</b><span id="agent-counter">#0</span></div>',
  '<div class="kv"><b>last seen</b><span id="agent-age">—</span></div>',
  '<div class="kv"><b>KILL TO SAFE</b><span class="timer" id="timer">00:00</span></div>',
  '</div>',
  '<div class="panel">',
  '<h2>Watchdog Quorum (2-of-3 via AXL)</h2>',
  '<div id="watchdogs">',
  '<div class="watchdog"><span class="id">watchdog-1.agent911.eth</span> <span class="stamp pending" data-w="1">pending</span></div>',
  '<div class="watchdog"><span class="id">watchdog-2.agent911.eth</span> <span class="stamp pending" data-w="2">pending</span></div>',
  '<div class="watchdog"><span class="id">watchdog-3.agent911.eth</span> <span class="stamp pending" data-w="3">pending</span></div>',
  '</div>',
  '<div class="kv"><b>quorum</b><span id="quorum-state">pending</span></div>',
  '<div class="kv"><b>failure confirmed tx</b><span class="hex" id="confirm-tx">—</span></div>',
  '</div>',
  '<div class="panel">',
  '<h2>Safe Wallet</h2>',
  '<div class="kv"><b>vault balance</b><span id="vault-bal">—</span></div>',
  '<div class="kv"><b>safe balance</b><span class="live" id="safe-bal">—</span></div>',
  '<div class="kv"><b>rescue tx</b><span class="hex" id="rescue-tx">—</span></div>',
  '<div class="kv"><b>block</b><span id="block">—</span></div>',
  '</div>',
  '</div>',
  '<div style="padding:0 20px 20px 20px;">',
  '<div class="panel">',
  '<h2>Live Event Log</h2>',
  '<div class="log" id="log"></div>',
  '</div>',
  '</div>',
  '<script>',
  'const $ = (id) => document.getElementById(id);',
  'const log = (msg) => { const el = $("log"); const line = document.createElement("div"); line.textContent = new Date().toISOString().slice(11,19) + "  " + msg; el.prepend(line); while (el.childNodes.length > 100) el.removeChild(el.lastChild); };',
  'let killTime = null; let tickT = null;',
  'function formatUsdc(wei) { if (!wei) return "0 mUSDC"; const n = BigInt(wei); const w = (Number(n) / 1e6).toLocaleString(undefined,{maximumFractionDigits:2}); return w + " mUSDC"; }',
  'function startTimer() { if (killTime) return; killTime = Date.now(); tickT = setInterval(()=> { const d = Math.floor((Date.now() - killTime)/1000); const m = String(Math.floor(d/60)).padStart(2,"0"); const s = String(d%60).padStart(2,"0"); $("timer").textContent = m + ":" + s; }, 500); }',
  'function stopTimer() { if (tickT) clearInterval(tickT); }',
  'function matchWatchdog(id) { if (id.startsWith("watchdog-1")) return "1"; if (id.startsWith("watchdog-2")) return "2"; if (id.startsWith("watchdog-3")) return "3"; return null; }',
  'function setText(id, txt) { const el = $(id); if (el) el.textContent = txt; }',
  'function setClass(id, cls) { const el = $(id); if (el) el.className = cls; }',
  'function setQuorumConfirmed() { const el = $("quorum-state"); if (!el) return; el.textContent = ""; const s = document.createElement("span"); s.className = "live"; s.textContent = "CONFIRMED"; el.appendChild(s); }',
  'const src = new EventSource("/events");',
  'src.onmessage = (ev) => {',
  '  const { type, payload } = JSON.parse(ev.data);',
  '  if (type === "heartbeat") { setText("agent-id", payload.agentId); setText("agent-status", "LIVE"); setClass("agent-status", "live"); setText("agent-counter", "#" + payload.counter); setText("agent-age", Math.round(payload.ageMs) + " ms"); }',
  '  else if (type === "agent_dead") { setText("agent-status", "OFFLINE"); setClass("agent-status", "dead"); startTimer(); log("main-agent OFFLINE (heartbeat stale " + Math.round(payload.ageMs) + "ms)"); }',
  '  else if (type === "attestation") { const n = matchWatchdog(payload.watchdogId); if (n) { const s = document.querySelector(\'[data-w="\' + n + \'"]\'); if (s) { s.textContent = "SIGNED"; s.classList.remove("pending"); } } log("attestation from " + payload.watchdogId + " (axl peer " + payload.fromPeer + ")"); }',
  '  else if (type === "failure_confirmed") { setQuorumConfirmed(); setText("confirm-tx", payload.txHash); log("FailureConfirmed at block " + payload.block); }',
  '  else if (type === "rescued") { setText("rescue-tx", payload.txHash); stopTimer(); log("RESCUED at block " + payload.block); }',
  '  else if (type === "chain_state") { setText("vault-bal", formatUsdc(payload.vaultBalance)); setText("safe-bal", formatUsdc(payload.safeBalance)); setText("block", String(payload.block)); }',
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
