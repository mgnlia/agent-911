#!/usr/bin/env tsx
/**
 * demo-kill-agent.ts — the demo's inflection point.
 * SIGKILL the main agent. The watchdogs + orchestrator take over from here.
 */

import { readFileSync, existsSync } from "node:fs";

const DEMO_STATE = "/tmp/agent-911/demo.json";

function main(): void {
  if (!existsSync(DEMO_STATE)) {
    console.error("no demo running (state file missing). Run `pnpm demo:start` first.");
    process.exit(1);
  }
  const st = JSON.parse(readFileSync(DEMO_STATE, "utf8")) as { pids: { mainAgent?: number } };
  const pid = st.pids.mainAgent;
  if (!pid) {
    console.error("no main-agent pid in state");
    process.exit(1);
  }
  try {
    // Negative PID = process group kill (handles tsx shell wrapper)
    process.kill(-pid, "SIGKILL");
  } catch {
    try { process.kill(pid, "SIGKILL"); } catch { /* gone */ }
  }
  console.log(`[demo-kill] SIGKILL → main-agent pid=${pid}`);
  console.log("[demo-kill] watch dashboard at http://127.0.0.1:4000/");
}

main();
