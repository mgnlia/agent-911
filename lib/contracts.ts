/**
 * Minimal contract ABIs + helpers we need from TypeScript.
 * Pulled from Foundry artifacts at runtime so we don't drift.
 */

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);
const OUT_DIR    = join(__dirname, "..", "out");

export function abi(contract: string): unknown[] {
  const artifact = JSON.parse(readFileSync(join(OUT_DIR, `${contract}.sol`, `${contract}.json`), "utf8"));
  return artifact.abi as unknown[];
}

export function bytecode(contract: string): `0x${string}` {
  const artifact = JSON.parse(readFileSync(join(OUT_DIR, `${contract}.sol`, `${contract}.json`), "utf8"));
  return artifact.bytecode.object as `0x${string}`;
}
