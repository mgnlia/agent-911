#!/usr/bin/env bash
# Launch 3 AXL nodes in the background, each with its own private key +
# distinct ports. Assumes `axl-node` is on PATH or AXL_NODE is set.
set -e

AXL_BIN="${AXL_NODE:-$(command -v axl-node || echo /tmp/axl-node)}"
if [ ! -x "$AXL_BIN" ]; then
  echo "axl-node binary not found (looked at: $AXL_BIN)" >&2
  echo "build it with: git clone https://github.com/gensyn-ai/axl && cd axl && go build -o $AXL_BIN ./cmd/node/" >&2
  exit 1
fi

ROOT="$(cd "$(dirname "$0")"/../.. && pwd)"
mkdir -p "$ROOT/infra/axl/logs" "$ROOT/infra/axl/run"

# Generate per-node ed25519 private keys as PEM if missing.
# Yggdrasil's config loader expects PEM-encoded ed25519 private keys.
for i in 1 2 3; do
  KEY_FILE="$ROOT/infra/axl/node-$i/private.pem"
  if [ ! -s "$KEY_FILE" ] || ! grep -q "BEGIN PRIVATE KEY" "$KEY_FILE" 2>/dev/null; then
    if ! command -v openssl >/dev/null 2>&1; then
      echo "openssl is required to generate ed25519 keys" >&2
      exit 1
    fi
    rm -f "$KEY_FILE"
    openssl genpkey -algorithm ed25519 -out "$KEY_FILE"
    chmod 600 "$KEY_FILE"
    echo "generated $KEY_FILE"
  fi
done

# Stop any existing AXL processes (best-effort)
pkill -f "$AXL_BIN -config" 2>/dev/null || true
sleep 1

for i in 1 2 3; do
  CFG="$ROOT/infra/axl/node-$i/node-config.json"
  LOG="$ROOT/infra/axl/logs/node-$i.log"
  PID="$ROOT/infra/axl/run/node-$i.pid"

  (cd "$ROOT" && "$AXL_BIN" -config "$CFG" > "$LOG" 2>&1 &)
  AXL_PID=$!
  echo "$AXL_PID" > "$PID"
  echo "node-$i started pid=$AXL_PID log=$LOG"
done

# Wait for API ports to come up
for port in 9101 9102 9103; do
  for _ in $(seq 1 30); do
    if curl -sS -o /dev/null -w "%{http_code}" "http://127.0.0.1:$port/topology" 2>/dev/null | grep -q "200\|204"; then
      echo "node@$port: UP"
      break
    fi
    sleep 1
  done
done

echo "---topology snapshot---"
for port in 9101 9102 9103; do
  echo "node@$port:"
  curl -sS "http://127.0.0.1:$port/topology" 2>/dev/null | head -c 200
  echo
done
