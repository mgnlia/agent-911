/**
 * Dead-simple file-backed heartbeat bus.
 *
 * Main agent writes {ts, pid, counter} every N ms to a known file.
 * Watchdogs poll the file's mtime + counter; a stale mtime or a missed
 * counter tick counts as a "missed heartbeat."
 *
 * Why file-backed: it survives kill -9 of the writer (the watchdog's
 * observation doesn't depend on the corpse still being there), works
 * across processes / AXL nodes that share a volume, and has zero setup
 * cost for Gate 2 verification. Day 4 swaps it for AXL A2A calls.
 */

import { writeFileSync, readFileSync, statSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export interface Heartbeat {
  ts: number;     // unix ms
  pid: number;
  counter: number;
  agentId: string;
}

export function writeHeartbeat(path: string, hb: Heartbeat): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(hb), { encoding: "utf8" });
}

export function readHeartbeat(path: string): Heartbeat | null {
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, "utf8");
    return JSON.parse(raw) as Heartbeat;
  } catch {
    return null;
  }
}

export function heartbeatAgeMs(path: string): number {
  if (!existsSync(path)) return Number.POSITIVE_INFINITY;
  try {
    return Date.now() - statSync(path).mtimeMs;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}
