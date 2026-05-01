#!/usr/bin/env bash
# demo-reshoot.sh — between-take reset and restart for the live 0G demo.
#
# Cleans demo state, kills stale tsx/agent processes, restarts the demo
# (mints a fresh policyId, deposits 10k mUSDC), waits for the dashboard,
# then opens it. ~60–90s end to end on the 0G testnet.
#
# Requirements: AXL mesh up (`bash infra/axl/up.sh`), PRIVATE_KEY set
# (defaults to the testnet deployer if unset).

set -e
cd "$(dirname "$0")/.."

# Default to the testnet deployer key if the caller hasn't set one.
PRIVATE_KEY="${PRIVATE_KEY:-0xda5ede9f6873cd43dab671809704c688c6ac6c353620bf960349f43a69583aa7}"
LOG="/tmp/demo-live-record.log"

echo "[reshoot] resetting demo state..."
pnpm demo:reset >/dev/null 2>&1 || true

echo "[reshoot] killing stale tsx/agent processes..."
ps -ax -o pid=,command= | grep -E "(tsx scripts|tsx agents)" | grep -v grep | awk '{print $1}' | xargs -I{} kill -9 {} 2>/dev/null || true
sleep 2

echo "[reshoot] checking AXL mesh..."
if ! bash infra/axl/status.sh 2>&1 | grep -q "node@9101: UP"; then
  echo "[reshoot] AXL mesh not up — bringing it up"
  export AXL_NODE="${AXL_NODE:-/tmp/axl-node}"
  bash infra/axl/up.sh >/dev/null 2>&1
  sleep 2
fi

echo "[reshoot] starting demo:live-record (real 0G testnet)..."
PRIVATE_KEY="$PRIVATE_KEY" nohup pnpm demo:live-record > "$LOG" 2>&1 &
disown

echo "[reshoot] waiting for [live] up... (typically 60–90s on 0G)"
SECS=0
while ! grep -q "\[live\] up\." "$LOG" 2>/dev/null; do
  if grep -q "FAILED" "$LOG" 2>/dev/null; then
    echo "[reshoot] demo FAILED — see $LOG"
    tail -20 "$LOG"
    exit 1
  fi
  sleep 3
  SECS=$((SECS + 3))
  if [ $SECS -gt 180 ]; then
    echo "[reshoot] timeout after 3 minutes — see $LOG"
    tail -20 "$LOG"
    exit 1
  fi
  printf "."
done
echo ""

# extract resolved safe address from log for the operator's reference
SAFE_LINE=$(grep "resolved safe.agent-911.eth" "$LOG" | tail -1 | sed 's/.*→ //')
echo "[reshoot] ready. safe.agent-911.eth → ${SAFE_LINE:-<fallback>}"
echo "[reshoot] dashboard: http://127.0.0.1:4000"
echo "[reshoot] when ready: pnpm demo:attack (0:45)  →  pnpm demo:kill (0:55)"
open http://127.0.0.1:4000 || true
