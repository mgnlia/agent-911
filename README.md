# Agent-911 × WatchdogQuorum

> **The primitive:** Autonomous agents need an external failure oracle. WatchdogQuorum lets independent agents attest that another agent is unhealthy, then triggers a preauthorized recovery action.
>
> **The demo:** When an onchain treasury agent crashes, independent ENS-named watchdogs prove failure onchain and Keeper executes the precommitted rescue — before the market does it for you.

Built for **ETHGlobal OpenAgents** (Apr 24 – May 3, 2026).

## Why this exists

In February 2026, an AI agent cascade triggered **$400M in liquidations** as autonomous trading agents simultaneously exited positions. 40% of on-chain transactions are now initiated by agents. Agentic wallets solve the *intent* problem (spending caps, whitelists, human leashes). None solve the **post-crash problem**: when an agent itself dies, hangs, or misses a liquidation window, funds are stranded in positions that were only safe while the agent was healthy.

A dead-man's-switch Safe module can't solve this either — it's timer-based. Agent-911 is *observer-based* with a *contextual runbook*.

## How it works

1. Before the agent starts, it registers a vault (`Agent911Vault`), a content-addressed runbook on **0G Storage**, and three independent watchdog agents on **separate AXL nodes** with ENS subnames (`main.agent911.eth`, `watchdog-{1,2,3}.agent911.eth`).
2. Each watchdog monitors heartbeat independently.
3. On silence, each signs an EIP-712 `FailureAttestation`.
4. Two of three signatures bundled into `confirmFailure(policyId, sigs[])` → **`WatchdogQuorum.sol`** emits `FailureConfirmed`.
5. **KeeperHub** (pre-warmed webhook) executes `Agent911Vault.rescue(policyId)` — exit position, swap to USDC via **Uniswap**, transfer to safe address.
6. Receipt stored on 0G Storage for audit.

```
Main agent (dies) ──heartbeat──► 3 Watchdogs on separate AXL nodes
                                        │
                                        │ 2-of-3 EIP-712 attestations
                                        ▼
                               WatchdogQuorum.sol
                                        │ FailureConfirmed
                                        ▼
                            KeeperHub (guaranteed exec)
                                        │
                                        ▼
                               Agent911Vault.rescue() ──► Uniswap swap ──► safe.agent911.eth
```

## Sponsor stack

| Sponsor | What it does here | Why this API |
|---|---|---|
| **0G Storage** | Runbook + encrypted policy metadata | Can't live in the dying agent. |
| **0G Compute (sealed)** | TEE executor decrypts runbook, emits signed `RescuePlan` | Private decision logic can't be front-run. |
| **0G Chain** | `WatchdogQuorum` + `Agent911Vault` + `Agent911PolicyNFT` | EVM, fast finality. |
| **Gensyn AXL** | Three watchdog binaries on distinct ports | Watchdogs on same host die with agent — definitional separation. |
| **KeeperHub** | Guaranteed rescue execution after quorum | Core value prop; without guarantee, rescue can be dropped. |
| **Uniswap** | Swap exit-position → USDC | Universal rescue route. `<internal>` included. |
| **ENS** | Subnames for every agent | First-class identifier in ERC-8004 registry. |
| **ERC-7857** | `Agent911PolicyNFT` | Policy is transferable/tradeable insurance product. |
| **ERC-8004** | Agent identity + reputation | New Ethereum standard (mainnet Jan 29, 2026). |

## Running the demo

```bash
pnpm install
pnpm hardhat compile
pnpm hardhat test
pnpm demo:start   # seeds position, boots agent + 3 watchdogs
# In another terminal:
pnpm demo:kill    # kill -9 on main agent
# Watch the dashboard at http://localhost:3000
pnpm demo:reset
```

## Layout

- `contracts/` — `WatchdogQuorum.sol`, `Agent911Vault.sol`, `Agent911PolicyNFT.sol`
- `agents/` — `main-agent.ts`, `watchdog-node-{1,2,3}.ts`, `rescue-executor.ts`
- `lib/` — `axl.ts`, `keeperhub.ts`, `zeroGStorage.ts`, `uniswap.ts`
- `scripts/` — `spike-rescue.ts`, `seed-position.ts`, `demo-{start,kill-agent,reset}.ts`
- `app/` — Next.js dashboard
- `docs/architecture.md`
- `<internal>` — Uniswap dev platform feedback

## Known failure modes (and mitigations)

- **False positive** → require per-watchdog observation source; reject quorum if all three RPC endpoints match.
- **Correlated observation** → watchdog attestation includes RPC fingerprint.
- **Stale runbook** → TTL + version hash enforced in `Agent911Vault.rescue`.
- **Slippage exploit during rescue** → KeeperHub dry-run step with circuit breaker on slippage delta.
- **Compromised watchdog key** → 2-of-3 threshold + ERC-8004 reputation slashing.

## Positioning

Not an agent marketplace (Olas, Virtuals, Fetch.ai). Not an agentic wallet (Coinbase, Openfort, Human.tech). Not a Safe dead-man's switch (timer-based). **The failure attestation layer + rescue orchestration primitive that every onchain agent needs when it dies.**

## Docs

- `<internal>` — 30-idea ideation + scoring rubric
- `<internal>` — 5-round codex debate log
- `<internal>` — architecture + 10-day plan
- `<internal>` — Day 1 first-4-hour runbook + realistic timing
- `<internal>` — 3-minute demo script

## Credits

Iterated with [OpenAI Codex CLI](https://github.com/openai/codex) across five red-team rounds. Original ideation by [Claude Opus 4.7](https://claude.com/claude-code).
