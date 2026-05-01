#!/usr/bin/env bash
# capture-dashboard.sh — fully-automated screenshot capture of the demo flow.
# Runs on a headless Linux box; requires google-chrome + forge + pnpm.
#
# Output: docs/screenshots/0{1..4}-*.png
set -e

OUT="docs/screenshots"
URL="http://127.0.0.1:4000/"
CHROME="${CHROME:-google-chrome}"

mkdir -p "$OUT"
pkill -9 -f "tsx scripts/demo-start" 2>/dev/null || true
pkill -9 -f "tsx scripts/event-bus"  2>/dev/null || true
pkill -9 -f "tsx agents/"            2>/dev/null || true
pkill -9 anvil                       2>/dev/null || true
rm -rf /tmp/agent-911
sleep 1

shot() {
  local name="$1"
  "$CHROME" --headless=new --disable-gpu --no-sandbox --hide-scrollbars \
    --virtual-time-budget=3000 --window-size=1440,1100 \
    --screenshot="$OUT/$name" "$URL" >/dev/null 2>&1
  echo "saved $OUT/$name ($(stat -c %s "$OUT/$name" 2>/dev/null || stat -f %z "$OUT/$name") bytes)"
}

# --- start demo in background ---
echo "[capture] starting demo..."
pnpm demo:start > /tmp/capture-demo.log 2>&1 &
DEMO_PID=$!

# Wait for event-bus (and therefore deploy + heartbeat) to be ready
for i in $(seq 1 60); do
  if curl -sS "$URL" -o /dev/null --max-time 2; then
    echo "[capture] dashboard up after ${i}s"
    break
  fi
  sleep 1
done

# Let heartbeats tick a few times
sleep 5
shot "01-healthy.png"

# Kill main-agent — this is the inflection point
echo "[capture] killing main-agent..."
pnpm demo:kill
sleep 2
shot "02-killed.png"

# Wait for 2/3 attestations
sleep 6
shot "03-signed.png"

# Wait for rescue tx to settle
sleep 10
shot "04-rescued.png"

# Teardown
pnpm demo:reset >/dev/null 2>&1 || true
kill -9 $DEMO_PID 2>/dev/null || true

ls -la "$OUT/"
echo "done"
