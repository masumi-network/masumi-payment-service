#!/usr/bin/env bash
# Restart ONE preprod hydra-node (1=purchasing, 2=selling) with optional
# persistence wipe and optional chain replay. Mirrors start_node_preprod in
# hydra-native.sh exactly (same ports, keys, periods).
#
# Usage: 97-restart-node.sh <1|2> [--wipe] [--from SLOT.HASH]
set -euo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PREPROD_DIR="$REPO/hydra-l2-flow/preprod"
STATE="$REPO/hydra-l2-flow/.native-state"
BIN="$REPO/hydra-l2-flow/.bin/hydra-node"
export DYLD_FALLBACK_LIBRARY_PATH="${DYLD_FALLBACK_LIBRARY_PATH:-/usr/lib}"

IDX="${1:?node index 1 or 2}"; shift
WIPE=0; FROM=""
while [ $# -gt 0 ]; do
  case "$1" in
    --wipe) WIPE=1; shift ;;
    --from) FROM="$2"; shift 2 ;;
    *) echo "unknown arg $1"; exit 1 ;;
  esac
done

if [ "$IDX" = 1 ]; then party=purchasing; other_vk=selling-hydra.vk; other_cvk=selling-cardano.vk; else party=selling; other_vk=purchasing-hydra.vk; other_cvk=purchasing-cardano.vk; fi
api=$((4000 + IDX)); p2p=$((5000 + IDX)); mon=$((6000 + IDX)); other=$(( IDX == 1 ? 2 : 1 ))
persist="$PREPROD_DIR/persistence/$party"

# Stop the node if running.
if [ -f "$STATE/node$IDX.pid" ] && kill -0 "$(cat "$STATE/node$IDX.pid")" 2>/dev/null; then
  kill "$(cat "$STATE/node$IDX.pid")"; sleep 2
  kill -9 "$(cat "$STATE/node$IDX.pid")" 2>/dev/null || true
  echo "[restart-node$IDX] stopped previous pid"
fi

if [ "$WIPE" = 1 ]; then
  stamp="$(date +%H%M%S)"
  mv "$persist" "$persist.wiped-$stamp" 2>/dev/null && echo "[restart-node$IDX] persistence moved to $party.wiped-$stamp" || echo "[restart-node$IDX] no persistence to wipe"
fi
mkdir -p "$persist"
rm -f "$persist/bin/etcd"

( "$BIN" \
    --node-id "$IDX" \
    --api-host 127.0.0.1 --api-port "$api" \
    --listen "127.0.0.1:$p2p" --monitoring-port "$mon" \
    --peer "127.0.0.1:$((5000 + other))" \
    --network preprod \
    --hydra-signing-key "$PREPROD_DIR/$party-hydra.sk" \
    --hydra-verification-key "$PREPROD_DIR/$other_vk" \
    --cardano-signing-key "$PREPROD_DIR/$party-cardano.sk" \
    --cardano-verification-key "$PREPROD_DIR/$other_cvk" \
    --ledger-protocol-parameters "$PREPROD_DIR/protocol-parameters.json" \
    --blockfrost "$PREPROD_DIR/blockfrost.txt" \
    --blockfrost-query-timeout 10 \
    --persistence-dir "$persist" \
    --contestation-period 220s \
    --deposit-period "${DEPOSIT_PERIOD:-300s}" \
    --unsynced-period 1800s \
    ${FROM:+--start-chain-from "$FROM"} \
    >>"$STATE/node$IDX.log" 2>&1 ) &
echo $! > "$STATE/node$IDX.pid"
echo "[restart-node$IDX] started pid $(cat "$STATE/node$IDX.pid")${FROM:+ replaying from $FROM}${WIPE:+ (wiped)}"
for _ in $(seq 1 60); do
  curl -sf "http://127.0.0.1:$api/protocol-parameters" >/dev/null 2>&1 && { echo "[restart-node$IDX] API up"; exit 0; }
  sleep 2
done
echo "[restart-node$IDX] API did not come up — see $STATE/node$IDX.log"; exit 1
