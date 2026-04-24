#!/usr/bin/env bash
set -e
ROOT="$(cd "$(dirname "$0")"/../.. && pwd)"
for i in 1 2 3; do
  PID_FILE="$ROOT/infra/axl/run/node-$i.pid"
  if [ -f "$PID_FILE" ]; then
    PID=$(cat "$PID_FILE")
    if kill -0 "$PID" 2>/dev/null; then
      kill "$PID" || true
      echo "node-$i stopped (pid=$PID)"
    fi
    rm -f "$PID_FILE"
  fi
done
# Catch any stragglers
pkill -f "axl.*node-config.json" 2>/dev/null || true
