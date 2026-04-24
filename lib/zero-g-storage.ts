/**
 * 0G Storage runbook client.
 *
 * Responsibilities:
 *   1. Define the Runbook schema (encrypted off-chain, hash committed onchain).
 *   2. Encrypt (AES-256-GCM) the runbook with a caller-provided key.
 *   3. Upload ciphertext to 0G Storage (testnet indexer), or fall back to
 *      a local content-addressed store for dev. Either way, return the same
 *      { uri, metadataHash } shape the AirbagPolicyNFT contract expects.
 *   4. Fetch + decrypt by uri.
 *
 * Design note: the NFT's `metadataHash` is keccak256 of the CIPHERTEXT, not
 * the plaintext. This lets anyone (watchdogs, vaults, auditors) verify that
 * the runbook used in a rescue matches what was committed, without ever
 * needing the decryption key.
 */

import { createCipheriv, createDecipheriv, randomBytes, createHash } from "node:crypto";
import { keccak256 as keccak256Hex, getBytes, toUtf8Bytes } from "ethers";
import { writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

export interface Runbook {
  version: 1;
  safeAddress: string;          // 0x-prefixed
  allowedAssets: string[];      // erc20 whitelist
  rescueSteps: RescueStep[];    // ordered executor plan
  slippageBps: number;          // 100 = 1%
  deadlineSecs: number;         // rescue tx must land within this window
  keeperWebhook?: string;       // KeeperHub workflow to trigger
  policyOwner: string;          // for audit
  notes?: string;
}

export type RescueStep =
  | { kind: "uniswapV3SwapExactInput"; tokenIn: string; tokenOut: string; fee: number; recipient?: string }
  | { kind: "erc20Transfer"; token: string; to: string }
  | { kind: "aavePositionClose"; asset: string; rate: "variable" | "stable" }
  | { kind: "sleep"; ms: number };

// --- encryption ---

const ALGO = "aes-256-gcm";

export interface Encrypted {
  ciphertext: Uint8Array; // = iv(12) || authTag(16) || body
}

export function encryptRunbook(runbook: Runbook, key: Uint8Array): Encrypted {
  if (key.byteLength !== 32) {
    throw new Error("encryption key must be 32 bytes (AES-256)");
  }
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGO, key, iv);
  const plaintext = Buffer.from(JSON.stringify(runbook));
  const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return { ciphertext: Uint8Array.from(Buffer.concat([iv, tag, body])) };
}

export function decryptRunbook(encrypted: Uint8Array, key: Uint8Array): Runbook {
  if (key.byteLength !== 32) {
    throw new Error("decryption key must be 32 bytes");
  }
  if (encrypted.byteLength < 12 + 16) {
    throw new Error("ciphertext too short");
  }
  const iv = encrypted.subarray(0, 12);
  const tag = encrypted.subarray(12, 12 + 16);
  const body = encrypted.subarray(12 + 16);
  const decipher = createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(Buffer.from(tag));
  const plaintext = Buffer.concat([decipher.update(body), decipher.final()]);
  return JSON.parse(plaintext.toString("utf8")) as Runbook;
}

// --- hashing ---

/**
 * Content-address for the vault's `metadataHash` (keccak256 over ciphertext).
 * Must be computed ONCE and committed to AirbagPolicyNFT.metadataHashOf(tokenId).
 */
export function runbookMetadataHash(encrypted: Uint8Array): `0x${string}` {
  return keccak256Hex(encrypted) as `0x${string}`;
}

// --- storage backends ---

export interface StorageUploadResult {
  uri: string;          // stored in AirbagPolicyNFT.encryptedURI
  metadataHash: `0x${string}`;
}

export interface ZeroGStorageOpts {
  indexerUrl?: string;  // e.g. https://indexer-storage-testnet-turbo.0g.ai
  localRoot?: string;   // fallback dir when indexer is unreachable
  preferLocal?: boolean;
}

export class ZeroGStorage {
  constructor(private readonly opts: ZeroGStorageOpts = {}) {
    this.opts.localRoot ??= "/tmp/agent-911/runbook-store";
    this.opts.indexerUrl ??= process.env.ZEROG_STORAGE_URL ?? "https://indexer-storage-testnet-turbo.0g.ai";
  }

  async upload(encrypted: Encrypted): Promise<StorageUploadResult> {
    const metadataHash = runbookMetadataHash(encrypted.ciphertext);

    if (!this.opts.preferLocal) {
      try {
        return await this._uploadRemote(encrypted, metadataHash);
      } catch (err) {
        // Fall through to local on any remote failure — do NOT silently accept
        // a broken indexer in production, but for hackathon CI we'd rather
        // keep the demo reproducible.
        process.stderr.write(`[0g-storage] remote upload failed (${String(err)}); using local\n`);
      }
    }

    return this._uploadLocal(encrypted, metadataHash);
  }

  async fetch(uri: string): Promise<Uint8Array> {
    if (uri.startsWith("file://")) {
      const path = uri.slice("file://".length);
      return Uint8Array.from(readFileSync(path));
    }
    if (uri.startsWith("0g://")) {
      const rootHash = uri.slice("0g://".length);
      const res = await fetch(`${this.opts.indexerUrl}/file?root=${rootHash}`);
      if (!res.ok) throw new Error(`0g fetch ${rootHash}: ${res.status}`);
      return new Uint8Array(await res.arrayBuffer());
    }
    throw new Error(`unknown uri scheme: ${uri}`);
  }

  private async _uploadRemote(enc: Encrypted, metadataHash: `0x${string}`): Promise<StorageUploadResult> {
    // 0G Storage testnet accepts multipart file uploads at /file.
    // Exact schema has shifted with indexer versions; we implement the
    // common interface and fall back locally on any 4xx/5xx.
    const form = new FormData();
    const blob = new Blob([enc.ciphertext], { type: "application/octet-stream" });
    form.append("file", blob, `${metadataHash.slice(2, 10)}.bin`);
    const res = await fetch(`${this.opts.indexerUrl}/file`, { method: "POST", body: form });
    if (!res.ok) throw new Error(`0g upload http ${res.status}`);
    const body = (await res.json()) as { root?: string; rootHash?: string };
    const rootHash = body.root ?? body.rootHash;
    if (!rootHash) throw new Error("0g upload: no root hash in response");
    return { uri: `0g://${rootHash}`, metadataHash };
  }

  private _uploadLocal(enc: Encrypted, metadataHash: `0x${string}`): StorageUploadResult {
    mkdirSync(this.opts.localRoot!, { recursive: true });
    const path = join(this.opts.localRoot!, `${metadataHash.slice(2)}.bin`);
    if (!existsSync(path)) writeFileSync(path, enc.ciphertext);
    return { uri: `file://${path}`, metadataHash };
  }
}

// --- key management helpers ---

/** Derive a per-policy AES key from a master secret + policyId. */
export function derivePolicyKey(masterHex: `0x${string}`, policyId: `0x${string}`): Uint8Array {
  const buf = Buffer.concat([getBytes(masterHex), getBytes(policyId)]);
  return new Uint8Array(createHash("sha256").update(buf).digest());
}

/** Random 32-byte key (for tests/dev). */
export function randomKey(): Uint8Array {
  return new Uint8Array(randomBytes(32));
}

// Unused helper to reassure TS about toUtf8Bytes import (kept for future use)
void toUtf8Bytes;
