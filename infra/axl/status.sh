#!/usr/bin/env bash
# One-shot health check of the 3-node mesh. Exits 0 iff all 3 respond.
set -e
ROOT="$(cd "$(dirname "$0")"/../.. && pwd)"
OK=0
for port in 9101 9102 9103; do
  code=$(curl -sS -o /tmp/axl-status-$$ -w "%{http_code}" "http://127.0.0.1:$port/topology" 2>/dev/null || echo "000")
  if [ "$code" = "200" ]; then
    PK=$(python3 -c "import json,sys; d=json.load(open('/tmp/axl-status-$$')); print(d.get('our_public_key','')[:16])" 2>/dev/null || echo "?")
    PEERS=$(python3 -c "import json,sys; d=json.load(open('/tmp/axl-status-$$')); print(len(d.get('peers',[])))" 2>/dev/null || echo "?")
    echo "node@$port: UP pk=$PK.. peers=$PEERS"
    OK=$((OK+1))
  else
    echo "node@$port: DOWN (http $code)"
  fi
done
rm -f /tmp/axl-status-$$
[ "$OK" = "3" ]
