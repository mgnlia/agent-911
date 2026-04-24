# Agent-911 × WatchdogQuorum

> **The primitive:** Autonomous agents need an external failure oracle. `WatchdogQuorum` lets independent agents attest that another agent is unhealthy, then triggers a preauthorized recovery action.
>
> **The demo:** When an onchain treasury agent crashes, independent ENS-named watchdogs on separate Gensyn AXL nodes prove failure onchain and KeeperHub executes the precommitted rescue — before the market does it for you.

Built for **ETHGlobal OpenAgents 2026** (Apr 24 – May 3).

---

## Why this exists

In February 2026, an AI agent cascade triggered **$400M in liquidations** as autonomous trading agents simultaneously exited positions. 40% of on-chain transactions are now initiated by agents. Agentic wallets (Coinbase, Human.tech, Openfort) solve the *intent* problem — spending caps, whitelists, human leashes — but **none solve the post-crash problem**: when the agent itself dies, hangs, hallucinates, or misses a liquidation window, funds are stranded in positions that were only safe while the agent was healthy.

A Safe dead-man's-switch can't solve this either — it's timer-based. Agent-911 is *observer-based* with a *contextual runbook*.

## The 20-second demo

```bash
pnpm demo:start          # in terminal 1: brings up everything
pnpm demo:kill           # in terminal 2: SIGKILL main-agent
                         # open http://127.0.0.1:4000 and watch the rescue
pnpm demo:reset          # tear it all down
```

What you'll see on the dashboard:
- **Main agent** heartbeats green, then flips to OFFLINE when killed.
- **Three ENS-named watchdogs** on distinct AXL nodes independently observe the silence, sign EIP-712 `FailureAttestation`s, send them through the AXL mesh.
- **A 2-of-3 quorum** fires `FailureConfirmed` onchain.
- **Rescue** sweeps the vault balance to the policy owner's safe address.
- A live `KILL-TO-SAFE` timer shows actual end-to-end rescue latency (measured ~13.5s under anvil; ~30s optimistic / ~90s realistic on public infra).

## Architecture

```
Main agent (dies)  ─heartbeat─►  3 Watchdogs, each on distinct AXL node
                                          │
                                          │  2-of-3 EIP-712 attestations
                                          │  over Gensyn AXL /send /recv
                                          ▼
                                WatchdogQuorum.sol (0G Chain)
                                          │ FailureConfirmed
                                          ▼
                                KeeperHub (guaranteed exec)
                                          │ rescue tx
                                          ▼
                              Agent911Vault.rescue(policyId, token)
                                          │
                                          ▼
                            reads policyNFT.safeAddressOf(tokenId)
                                          │
                           ──────┬─────────┴────────────────────────
                           │ OR via Agent911UniswapExecutor       │
                           │   exit-position → USDC via v3 SwapRouter
                                          │
                                          ▼
                                  safe.agent911.eth
```

## What's on-chain

| Contract | Role |
|---|---|
| `WatchdogQuorum.sol` | EIP-712 m-of-n failure oracle. `registerPolicy` + `confirmFailure(bundled sigs)`. Reusable primitive — any project can register its own watchdog set. |
| `Agent911Vault.sol` | Holds ERC20 deposits. `rescue(policyId, token)` is permissionless but gated on `quorum.isFailed()`. Sweeps to policy NFT's safe address. |
| `Agent911PolicyNFT.sol` | ERC-7857-flavored ERC-721. Owner controls the encrypted runbook URI, metadata hash, and safe address. Transferring the NFT changes the rescue target without redeploying the vault. |
| `Agent911UniswapExecutor.sol` | Optional rescue extension. Unwinds volatile positions into USDC via Uniswap v3 `exactInputSingle` before forwarding to safe. |
| `AgentIdentityRegistry.sol` | ERC-8004-style trustless agent identity + reputation + validation. Agents register, operators sign, feedback accumulates onchain. |

## Sponsor stack (every API is load-bearing)

| Sponsor | What it does here | Why this API |
|---|---|---|
| **0G Chain** | Deploys `WatchdogQuorum` + `Agent911Vault` + `Agent911PolicyNFT` + `Agent911UniswapExecutor` + `AgentIdentityRegistry`. Testnet chain 16602. | EVM, ~2s block time. |
| **0G Storage** | Encrypted runbook (AES-256-GCM) content-addressed. `metadataHash = keccak256(ciphertext)` committed onchain. | The runbook can't live in the dying agent. |
| **0G Compute (sealed)** | Planned hook: TEE executor decrypts runbook, emits signed `RescuePlan` that the vault verifies. Stub today; wires up once sealed-inference enclaves are provisioned. | Private decision logic kept hidden until rescue fires. |
| **Gensyn AXL** | **3 AXL binaries running as 3 distinct Yggdrasil peers on ports 9101/9102/9103.** Watchdogs send EIP-712 signatures over `/send`, coordinator polls `/recv`. Real mesh — not in-process. | Definitional: a watchdog on the same host as the agent dies *with* it. |
| **KeeperHub** | Pre-warmed webhook triggers `Agent911Vault.rescue(...)` after `FailureConfirmed` emits. Falls back to direct ethers signer when `KH_API_KEY` unset. | Guaranteed execution — without it rescue can be front-run or dropped. |
| **Uniswap** | `Agent911UniswapExecutor.rescueWithSwap` takes `SwapPlan{tokenIn, tokenOut, fee, minOut, deadline}` and calls `exactInputSingle`. | Universal exit route to a safe asset. |
| **ENS** | Every actor has an ENS subname under `agent911.eth`: `main.agent911.eth`, `watchdog-{1,2,3}.agent911.eth`, `safe.agent911.eth`. | First-class identifier in ERC-8004 Identity Registry (per ENS × ERC-8004 blog). |
| **ERC-7857** | `Agent911PolicyNFT` is the runbook iNFT — owner controls safe address + encrypted URI. | Transfer the NFT → rescue behavior changes without vault redeploy. |
| **ERC-8004** | `AgentIdentityRegistry` — Identity + Reputation + Validation registries live on 0G Chain. Watchdog reputation grows per correct attestation. | Brand-new Ethereum standard (mainnet Jan 29, 2026). |

## Running locally

### Prerequisites

- Node.js 22+, pnpm 10+
- Foundry (`forge`, `cast`, `anvil`) — install with `curl -L https://foundry.paradigm.xyz | bash && foundryup`
- Go 1.22+ (to build Gensyn AXL)

### Setup

```bash
git clone https://github.com/guzus/agent-911
cd agent-911
pnpm install
forge build
```

### Build Gensyn AXL

```bash
git clone https://github.com/gensyn-ai/axl && ( cd axl && go build -o /tmp/axl-node ./cmd/node/ )
export AXL_NODE=/tmp/axl-node
```

### Run the demo

```bash
bash infra/axl/up.sh          # 3-node mesh (generates per-node PEM keys on first run)
pnpm demo:start               # (in terminal 1)
pnpm demo:kill                # (in terminal 2) — the inflection moment
# open http://127.0.0.1:4000 to watch
pnpm demo:reset               # clean teardown
bash infra/axl/down.sh        # stop the mesh
```

### Tests

```bash
forge test -vv                # 19 contract tests
pnpm spike                    # Gate 2: file-bus end-to-end kill→rescue
pnpm spike:axl                # Gate 2: AXL-mesh end-to-end kill→rescue
pnpm exec tsx scripts/axl-smoke.ts  # 3-node topology + send/recv roundtrip
```

## Deployment

```bash
cp .env.example .env          # fill in PRIVATE_KEY etc.
pnpm deploy:0g                # 0G testnet (chain 16602)
```

### Live on 0G Testnet (Galileo, chain 16602)

| Contract | Address |
|---|---|
| `WatchdogQuorum` | [`0x005319a89579eFA98abf167fd9C471AAFD14ef93`](https://chainscan-galileo.0g.ai/address/0x005319a89579eFA98abf167fd9C471AAFD14ef93) |
| `Agent911PolicyNFT` | [`0xfc982634E1555Bfc73B5BAc8Ff0264e4e42aa940`](https://chainscan-galileo.0g.ai/address/0xfc982634E1555Bfc73B5BAc8Ff0264e4e42aa940) |
| `Agent911Vault` | [`0x048368Ad21cb18CCfe35532049831F6591098ce6`](https://chainscan-galileo.0g.ai/address/0x048368Ad21cb18CCfe35532049831F6591098ce6) |
| `MockERC20 (mUSDC)` | [`0xA470fe8611990DeB0760F481f30C9F4DB4755ba0`](https://chainscan-galileo.0g.ai/address/0xA470fe8611990DeB0760F481f30C9F4DB4755ba0) |

Full deployment record: [`deployments/0g-testnet.json`](./deployments/0g-testnet.json).

Deployer: `0xa64ed1bd9D75338f65F8E1d65b58330D9A4E0091` (testnet-only throwaway; fund via https://faucet.0g.ai or the [OpenAgents Telegram support channel](https://t.me/+mQmldXXVBGpkODU1)).

## Project layout

```
contracts (forge)
  src/WatchdogQuorum.sol             # EIP-712 m-of-n oracle
  src/Agent911Vault.sol              # rescue-gated ERC20 vault
  src/Agent911PolicyNFT.sol          # ERC-7857-flavored policy iNFT
  src/Agent911UniswapExecutor.sol    # Uniswap v3 rescue extension
  src/AgentIdentityRegistry.sol      # ERC-8004-lite identity + reputation
  src/mocks/MockERC20.sol
  test/*.t.sol                       # 19 tests, Foundry
  script/Deploy.s.sol                # 0G deploy script

agents
  agents/main-agent.ts               # heartbeat emitter
  agents/watchdog.ts                 # file-bus watchdog (Gate 2 A)
  agents/watchdog-axl.ts             # AXL-routed watchdog (Gate 2 B)

libs
  lib/eip712.ts                      # attestation signer
  lib/heartbeat-bus.ts               # file-backed heartbeat
  lib/contracts.ts                   # ABI loader from Foundry out/
  lib/axl.ts                         # Gensyn AXL HTTP client
  lib/zero-g-storage.ts              # encrypted runbook + 0G upload
  lib/keeperhub.ts                   # KeeperHub client + local fallback

orchestration
  scripts/spike-rescue.ts            # Gate 2 (file bus)
  scripts/spike-rescue-axl.ts        # Gate 2 (real AXL mesh)
  scripts/axl-smoke.ts               # AXL mesh health check
  scripts/demo-start.ts              # full demo bring-up
  scripts/demo-kill-agent.ts         # the inflection point
  scripts/demo-reset.ts              # one-command teardown
  scripts/event-bus.ts               # SSE server + dashboard HTML

infra
  infra/axl/node-{1,2,3}/node-config.json
  infra/axl/up.sh / down.sh / status.sh
```

## Measured rescue timing

### Local (anvil, 2s block time) — `pnpm spike:axl`

| Segment | Time |
|---|---:|
| Kill → 3/3 attestations via AXL | ~9.4s |
| Kill → `FailureConfirmed` onchain | ~9.4s |
| Kill → funds at safe | ~13.5s |

### Live on 0G testnet — `pnpm demo:live` ([summary](./deployments/live-run.json))

| Segment | Time |
|---|---:|
| Kill → 3/3 attestations via AXL mesh | **5.48s** |
| Kill → `FailureConfirmed` on 0G | **13.11s** |
| Kill → funds at safe on 0G | **20.51s** |

Live-run transaction hashes (all on [chainscan-galileo](https://chainscan-galileo.0g.ai)):

| Step | Tx hash |
|---|---|
| `mintPolicy` | [`0xe5342fb4…`](https://chainscan-galileo.0g.ai/tx/0xe5342fb4519278804892ef1d78dd8451f0188ff533ae7c4cea3a5c9559c3fae4) |
| `bindPolicy` | [`0x19db435f…`](https://chainscan-galileo.0g.ai/tx/0x19db435f43bc89f295244fe2e50ef8d1fa7480e656c6e8d362ab7942bb03de53) |
| `registerPolicy` | [`0x5673746f…`](https://chainscan-galileo.0g.ai/tx/0x5673746f898a009b921cee297d1e094c0e19b9251f103d613e513ddbebddcd08) |
| `deposit` | [`0x9d25a882…`](https://chainscan-galileo.0g.ai/tx/0x9d25a882d54d28d483715356de60a7bfd354ef5fbb4ec46791d2121586a455cf) |
| **`confirmFailure`** (block 29,566,814) | [`0xa74b14fd…`](https://chainscan-galileo.0g.ai/tx/0xa74b14fdb25d9a9052262e1d31652a5362e6dee13e6dd36bac761cbb497d5799) |
| **`rescue`** (block 29,566,831) | [`0x52d85cb6…`](https://chainscan-galileo.0g.ai/tx/0x52d85cb6052f0a760cad2ab362e9d336937ce8827d5aa6fc7c6e1be428dedcc2) |

Realistic public-infrastructure budget (from our red-team analysis in [<internal>](./<internal>)): 30s optimistic / 98s realistic / 2-5 min in the bad case. We pre-warm the KeeperHub webhook and bundle all attestations into one quorum tx — measured at **~21s** on live 0G testnet.

## Known failure modes (not hidden)

- **False positive** → require per-watchdog observation source; reject quorum if all three RPC endpoints match (not yet enforced onchain).
- **Correlated observation** → watchdog attestation includes a source fingerprint (off-chain, Day-8 polish).
- **Stale runbook** → TTL + version hash in Agent911Vault (planned).
- **Slippage exploit during rescue** → KeeperHub dry-run step with circuit breaker on slippage delta.
- **Compromised watchdog key** → 2-of-3 threshold + ERC-8004 reputation slashing in `AgentIdentityRegistry`.

## Docs

- [<internal>](./<internal>) — 30-idea ideation + scoring rubric
- [<internal>](./<internal>) — 6-round codex debate that landed us on this idea
- [<internal>](./<internal>) — architecture deep dive + 10-day plan
- [<internal>](./<internal>) — Day 1 first-4-hour runbook + realistic timing
- [<internal>](./<internal>) — 3-minute demo video script
- [<internal>](./<internal>) — 8-panel cartoon for non-crypto audiences
- [<internal>](./<internal>) — sponsor-platform feedback (Uniswap, KeeperHub, Gensyn, ENS, 0G)

## Credits

Iterated with [OpenAI Codex CLI](https://github.com/openai/codex) across multiple adversarial review rounds. Implementation by [Claude Opus 4.7](https://claude.com/claude-code) on a <vps> VPS.
