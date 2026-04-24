# Agent-911 — Programmatic Video

A [Remotion](https://remotion.dev) project that renders the 70-second Agent-911 explainer straight from TypeScript. No screen-recording, no mouse movement — each frame is deterministic, so the video can be re-rendered verbatim from source.

The output is at [`out/agent-911.mp4`](./out/agent-911.mp4) — 1920×1080, 30 fps, 70s, ~6.6 MB.

## Scene breakdown

| # | Scene | Duration | What it shows |
|---|---|---|---|
| 1 | **Title** | 4s | `Agent-911`, pulsing red beacon, tagline |
| 2 | **Problem** | 8s | `$400M` counter, Feb 2026 cascade, 40% of onchain tx now agent-initiated |
| 3 | **Healthy** | 8s | Tri-pane: agent with ticking heartbeat + ECG + vault holding 10k mUSDC |
| 4 | **Kill** | 6s | Terminal types `kill -9`, status flips LIVE → OFFLINE, timer starts |
| 5 | **Watchdogs** | 10s | Three watchdog cards (on distinct AXL nodes) flip pending → SIGNED one by one |
| 6 | **Rescue** | 9s | Quorum 2/3 → `FailureConfirmed` → KeeperHub executes → vault drains → safe fills |
| 7 | **Receipt** | 9s | Live 0G testnet receipt: tx hashes + block numbers + 20.51s end-to-end timer |
| 8 | **Stack** | 10s | Five sponsor rows slide in, each with their load-bearing role |
| 9 | **Outro** | 6s | `github.com/guzus/agent-911` + the primitive thesis |

## Running

```bash
cd video
pnpm install
pnpm dev       # open Remotion Studio for iteration
pnpm build     # render to out/agent-911.mp4
```

## Tweaking

- `src/Video.tsx` — scene durations (edit the `SCENES` array; total frames recompute automatically)
- `src/theme.ts` — colors (mirrors the live dashboard from `scripts/event-bus.ts`)
- `src/scenes/*.tsx` — individual panels; each is a `React.FC` that reads `useCurrentFrame()`

## Why render it this way

- **Reproducible**: re-renders identically every time. Tx hashes, timings, and receipt text come from `deployments/live-run.json` and are hardcoded in `src/scenes/Receipt.tsx` + `src/scenes/Rescue.tsx`.
- **No screen recording artifacts**: no mouse drift, no browser scrollbars, no unscripted panel state.
- **Cheap to iterate**: fix a label, re-render in 60s, get a clean MP4.
- **Composable**: sub-scenes are independent `React.FC`s; swap Receipt → ExtendedReceipt without touching anything else.

The full ETHGlobal submission still benefits from a live recording (showing the actual dashboard react in real time is more convincing than a rendered UI that looks the same), but this version is the canonical "how does Agent-911 work?" video.
