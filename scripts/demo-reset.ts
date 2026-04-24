#!/usr/bin/env tsx
/**
 * demo-reset.ts — fully tear down the demo (stop procs, wipe state,
 * leave AXL mesh running). Idempotent.
 */

import { readFileSync, existsSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";

const DEMO_STATE = "/tmp/agent-911/demo.json";

function killPid(pid: number | undefined): void {
  if (!pid) return;
  try { process.kill(-pid, "SIGKILL"); } catch { try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } }
}

function main(): void {
  if (existsSync(DEMO_STATE)) {
    const st = JSON.parse(readFileSync(DEMO_STATE, "utf8")) as { pids: { anvil?: number; mainAgent?: number; watchdogs?: number[]; eventBus?: number } };
    killPid(st.pids.mainAgent);
    killPid(st.pids.anvil);
    killPid(st.pids.eventBus);
    for (const p of st.pids.watchdogs ?? []) killPid(p);
  }

  // Best-effort cleanup of anything we might have missed
  spawnSync("pkill", ["-9", "-f", "tsx agents/"], { stdio: "ignore" });
  spawnSync("pkill", ["-9", "anvil"],            { stdio: "ignore" });

  // Wipe demo state (but keep AXL mesh up)
  if (existsSync("/tmp/agent-911")) {
    rmSync("/tmp/agent-911", { recursive: true, force: true });
  }
  console.log("[demo-reset] demo state cleared. AXL mesh left running.");
  console.log("[demo-reset] to stop AXL too: bash infra/axl/down.sh");
}

main();
