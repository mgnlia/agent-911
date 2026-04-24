#!/usr/bin/env tsx
/**
 * main-agent.ts — the treasury agent that is supposed to stay alive.
 *
 * Usage:
 *   tsx agents/main-agent.ts \
 *     --agent-id main.agent-911.eth \
 *     --heartbeat-path /tmp/agent-911/heartbeat.json \
 *     --interval-ms 2000
 *
 * During the demo this is the process you `kill -9`. Watchdogs monitor
 * the heartbeat file; if it stops updating for threshold*interval ms,
 * they sign a FailureAttestation.
 */

import { parseArgs } from "node:util";
import { writeHeartbeat } from "../lib/heartbeat-bus.ts";

interface Args {
  agentId: string;
  heartbeatPath: string;
  intervalMs: number;
}

function parse(): Args {
  const { values } = parseArgs({
    options: {
      "agent-id":       { type: "string", default: "main.agent-911.eth" },
      "heartbeat-path": { type: "string", default: "/tmp/agent-911/heartbeat.json" },
      "interval-ms":    { type: "string", default: "2000" },
    },
    strict: true,
  });
  return {
    agentId: values["agent-id"] as string,
    heartbeatPath: values["heartbeat-path"] as string,
    intervalMs: parseInt(values["interval-ms"] as string, 10),
  };
}

async function main(): Promise<void> {
  const args = parse();
  let counter = 0;

  const beat = () => {
    counter++;
    writeHeartbeat(args.heartbeatPath, {
      ts: Date.now(),
      pid: process.pid,
      counter,
      agentId: args.agentId,
    });
    process.stdout.write(
      `[main-agent ${args.agentId} pid=${process.pid}] heartbeat #${counter} → ${args.heartbeatPath}\n`
    );
  };

  beat();
  const handle = setInterval(beat, args.intervalMs);

  // Graceful shutdown on SIGTERM (demo uses SIGKILL to skip this path)
  const shutdown = (sig: string) => {
    console.error(`[main-agent] caught ${sig}, exiting cleanly`);
    clearInterval(handle);
    process.exit(0);
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT",  () => shutdown("SIGINT"));

  // Stay alive forever
  await new Promise<void>(() => { /* never resolves */ });
}

main().catch((err: unknown) => {
  console.error("[main-agent] fatal:", err);
  process.exit(1);
});
