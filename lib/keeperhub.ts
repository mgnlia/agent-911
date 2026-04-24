/**
 * KeeperHub client.
 *
 * Status (hackathon):
 *   - KeeperHub requires signup at app.keeperhub.com and issues a per-user
 *     API key + workflow ID. This client is structured so you can drop in
 *     credentials via env and it Just Works.
 *   - Without credentials, the client still exposes the interface and
 *     falls back to in-process execution (directly calling the vault via
 *     ethers) so end-to-end demos run offline.
 *
 * What KeeperHub gives us:
 *   - Guaranteed execution (exponential backoff, nonce management,
 *     multi-RPC failover).
 *   - Pay-per-execution in USDC via x402/MPP.
 *   - MCP server so agents can discover it.
 *
 * The only KH primitive we need for the Agent-911 demo is "fire a
 * preauthorized rescue tx after FailureConfirmed emits". Everything else
 * is marketing glitter.
 */

import { JsonRpcProvider, Wallet, Contract, Interface } from "ethers";

export interface RescueJobSpec {
  policyId: `0x${string}`;
  vaultAddress: `0x${string}`;
  token: `0x${string}`;
  // Optional: pre-funded gas wallet; if omitted, KeeperHub uses account balance
  gasPayer?: `0x${string}`;
}

export interface RescueReceipt {
  executedBy: "keeperhub" | "local";
  txHash: `0x${string}`;
  blockNumber: number;
  durationMs: number;
}

export interface KeeperHubOpts {
  apiKey?: string;       // KH_API_KEY
  workflowId?: string;   // KH_WORKFLOW_ID
  baseUrl?: string;      // api.keeperhub.com
  rpcUrl: string;        // fallback direct-execution RPC
  signerPk?: string;     // fallback signer
}

export class KeeperHub {
  constructor(private readonly opts: KeeperHubOpts) {
    this.opts.baseUrl ??= process.env.KH_BASE_URL ?? "https://api.keeperhub.com";
  }

  get hasCreds(): boolean {
    return Boolean(this.opts.apiKey && this.opts.workflowId);
  }

  /**
   * Request KeeperHub to execute the rescue. If no credentials are
   * available, execute directly with a local signer as the fallback path
   * documented in <internal> ("pre-warmed KeeperHub webhook").
   */
  async executeRescue(spec: RescueJobSpec): Promise<RescueReceipt> {
    const started = Date.now();
    if (this.hasCreds) {
      return await this._executeRemote(spec, started);
    }
    return await this._executeLocal(spec, started);
  }

  private async _executeRemote(spec: RescueJobSpec, started: number): Promise<RescueReceipt> {
    const res = await fetch(`${this.opts.baseUrl}/v1/workflows/${this.opts.workflowId}/trigger`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${this.opts.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        inputs: {
          policyId:   spec.policyId,
          vault:      spec.vaultAddress,
          token:      spec.token,
          gasPayer:   spec.gasPayer ?? null,
        },
      }),
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`KeeperHub trigger failed: ${res.status} ${body}`);
    }
    const body = (await res.json()) as { txHash?: string; blockNumber?: number };
    if (!body.txHash) throw new Error("KeeperHub returned no txHash");
    return {
      executedBy: "keeperhub",
      txHash: body.txHash as `0x${string}`,
      blockNumber: body.blockNumber ?? 0,
      durationMs: Date.now() - started,
    };
  }

  private async _executeLocal(spec: RescueJobSpec, started: number): Promise<RescueReceipt> {
    if (!this.opts.signerPk) {
      throw new Error("KeeperHub has no credentials AND no local signer — cannot execute");
    }
    const provider = new JsonRpcProvider(this.opts.rpcUrl);
    const signer = new Wallet(this.opts.signerPk, provider);
    const iface = new Interface([
      "function rescue(bytes32 policyId, address token)",
    ]);
    const vault = new Contract(spec.vaultAddress, iface, signer);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tx = await (vault as any).rescue(spec.policyId, spec.token);
    const rc = await tx.wait();
    return {
      executedBy: "local",
      txHash: tx.hash as `0x${string}`,
      blockNumber: rc?.blockNumber ?? 0,
      durationMs: Date.now() - started,
    };
  }
}
