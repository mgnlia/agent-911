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

// Ethers v6 InterfaceAbi accepts JsonFragment[] / string[] / Fragment[].
// Foundry artifacts give us a JsonFragment[] directly; we type it loosely
// because enumerating every Fragment shape isn't worth the cycles here.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type LooseAbi = any[];

export function abi(contract: string): LooseAbi {
  const artifact = JSON.parse(readFileSync(join(OUT_DIR, `${contract}.sol`, `${contract}.json`), "utf8"));
  return artifact.abi as LooseAbi;
}

export function bytecode(contract: string): `0x${string}` {
  const artifact = JSON.parse(readFileSync(join(OUT_DIR, `${contract}.sol`, `${contract}.json`), "utf8"));
  return artifact.bytecode.object as `0x${string}`;
}
