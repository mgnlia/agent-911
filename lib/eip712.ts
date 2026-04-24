/**
 * EIP-712 signer for WatchdogQuorum FailureAttestation.
 *
 * Must stay in lockstep with the typehash in contracts/WatchdogQuorum.sol:
 *
 *   FailureAttestation(
 *     bytes32 policyId,
 *     bytes32 runbookHash,
 *     uint64  observedAt,
 *     uint64  expiry,
 *     uint256 chainId
 *   )
 *
 * Domain:
 *   name    = "WatchdogQuorum"
 *   version = "1"
 *
 * If you change either side, update both or the contract will reject every sig.
 */

import { Wallet, TypedDataDomain, TypedDataField } from "ethers";

export const ATTESTATION_TYPES: Record<string, TypedDataField[]> = {
  FailureAttestation: [
    { name: "policyId",    type: "bytes32" },
    { name: "runbookHash", type: "bytes32" },
    { name: "observedAt",  type: "uint64"  },
    { name: "expiry",      type: "uint64"  },
    { name: "chainId",     type: "uint256" },
  ],
};

export interface Attestation {
  observedAt: bigint;
  expiry: bigint;
  signature: `0x${string}`;
}

export function domain(chainId: number | bigint, verifyingContract: string): TypedDataDomain {
  return {
    name: "WatchdogQuorum",
    version: "1",
    chainId,
    verifyingContract,
  };
}

export interface SignArgs {
  privateKey: string;          // 0x-prefixed hex
  policyId: `0x${string}`;
  runbookHash: `0x${string}`;
  observedAt: number | bigint; // unix seconds
  expiry: number | bigint;
  chainId: number | bigint;
  verifyingContract: `0x${string}`;
}

export async function signAttestation(args: SignArgs): Promise<Attestation> {
  const wallet = new Wallet(args.privateKey);
  const message = {
    policyId: args.policyId,
    runbookHash: args.runbookHash,
    observedAt: BigInt(args.observedAt),
    expiry: BigInt(args.expiry),
    chainId: BigInt(args.chainId),
  };
  const sig = await wallet.signTypedData(domain(args.chainId, args.verifyingContract), ATTESTATION_TYPES, message);
  return {
    observedAt: BigInt(args.observedAt),
    expiry: BigInt(args.expiry),
    signature: sig as `0x${string}`,
  };
}

/** Recover for client-side sanity checks (the contract recovers onchain). */
export function recoverAttestationSigner(
  args: Omit<SignArgs, "privateKey">,
  signature: `0x${string}`
): string {
  const { verifyTypedData } = require("ethers") as typeof import("ethers");
  return verifyTypedData(
    domain(args.chainId, args.verifyingContract),
    ATTESTATION_TYPES,
    {
      policyId: args.policyId,
      runbookHash: args.runbookHash,
      observedAt: BigInt(args.observedAt),
      expiry: BigInt(args.expiry),
      chainId: BigInt(args.chainId),
    },
    signature
  );
}
