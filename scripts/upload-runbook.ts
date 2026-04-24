#!/usr/bin/env tsx
/**
 * upload-runbook.ts — produces the encrypted runbook we commit to the
 * Agent911PolicyNFT on 0G. Prints the URI + metadataHash to stdout and
 * optionally writes JSON to --out.
 *
 * Usage:
 *   tsx scripts/upload-runbook.ts \
 *     --policy-id 0x... \
 *     --safe-address 0x... \
 *     --master-key 0x... \
 *     --usdc 0xA470fe8611990DeB0760F481f30C9F4DB4755ba0 \
 *     --out /tmp/agent-911/runbook.json
 */

import { parseArgs } from "node:util";
import { writeFileSync } from "node:fs";
import { ZeroGStorage, encryptRunbook, derivePolicyKey, type Runbook } from "../lib/zero-g-storage.ts";

interface Args {
  policyId: `0x${string}`;
  safeAddress: `0x${string}`;
  masterKey: `0x${string}`;
  tokenIn: `0x${string}`;
  tokenOut: `0x${string}`;
  out?: string;
  preferLocal: boolean;
}

function parse(): Args {
  const { values } = parseArgs({
    options: {
      "policy-id":     { type: "string" },
      "safe-address":  { type: "string" },
      "master-key":    { type: "string", default: "0x" + "11".repeat(32) },
      "token-in":      { type: "string" },
      "token-out":     { type: "string" },
      "out":           { type: "string" },
      "prefer-local":  { type: "boolean", default: false },
    },
    strict: true,
  });
  for (const k of ["policy-id", "safe-address", "token-in", "token-out"] as const) {
    if (!values[k]) throw new Error(`--${k} required`);
  }
  return {
    policyId:    values["policy-id"]    as `0x${string}`,
    safeAddress: values["safe-address"] as `0x${string}`,
    masterKey:   values["master-key"]   as `0x${string}`,
    tokenIn:     values["token-in"]     as `0x${string}`,
    tokenOut:    values["token-out"]    as `0x${string}`,
    out:         values.out as string | undefined,
    preferLocal: Boolean(values["prefer-local"]),
  };
}

async function main(): Promise<void> {
  const args = parse();

  const runbook: Runbook = {
    version: 1,
    safeAddress: args.safeAddress,
    allowedAssets: [args.tokenIn, args.tokenOut],
    rescueSteps: [
      { kind: "uniswapV3SwapExactInput", tokenIn: args.tokenIn, tokenOut: args.tokenOut, fee: 3000 },
      { kind: "erc20Transfer", token: args.tokenOut, to: args.safeAddress },
    ],
    slippageBps: 100,
    deadlineSecs: 900,
    policyOwner: args.safeAddress,
    notes: "Agent-911 live demo runbook — exit to USDC, forward to safe",
  };

  const key = derivePolicyKey(args.masterKey, args.policyId);
  const encrypted = encryptRunbook(runbook, key);

  const store = new ZeroGStorage({ preferLocal: args.preferLocal });
  const result = await store.upload(encrypted);

  const out = {
    uri:          result.uri,
    metadataHash: result.metadataHash,
    policyId:     args.policyId,
    ciphertextBytes: encrypted.ciphertext.length,
  };

  console.log(JSON.stringify(out, null, 2));
  if (args.out) {
    writeFileSync(args.out, JSON.stringify(out, null, 2));
    process.stderr.write(`wrote ${args.out}\n`);
  }
}

main().catch((err: unknown) => {
  console.error("upload-runbook failed:", err);
  process.exit(1);
});
