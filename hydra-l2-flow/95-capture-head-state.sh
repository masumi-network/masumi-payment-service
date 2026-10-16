#!/usr/bin/env bash
# Capture everything an external store would need to recover a Hydra head:
# the full ConfirmedSnapshot (with multisignature) from each node, the in-head
# UTxO map, and the last-seen snapshot marker. This simulates "the payment
# service stored the latest signed snapshot in its DB".
#
# Usage: ./95-capture-head-state.sh <label>
set -euo pipefail
LABEL="${1:?usage: 95-capture-head-state.sh <label>}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Default under evidence/, not preprod/: hydra-l2-flow/.gitignore ignores the
# whole of preprod/, which is why these captures could never ship with a PR.
CAPTURE_ROOT="${CAPTURE_ROOT:-$HERE/evidence/captures}"
DIR="$CAPTURE_ROOT/$LABEL"
mkdir -p "$DIR"
for port in 4001 4002; do
  for ep in snapshot snapshot/utxo snapshot/last-seen head; do
    out="$DIR/node${port#400}-${ep//\//-}.json"
    if curl -sf "http://127.0.0.1:$port/$ep" -o "$out"; then
      echo "captured :$port /$ep -> $(wc -c < "$out") bytes"
    else
      echo "MISS :$port /$ep (endpoint absent or node down)"
      rm -f "$out"
    fi
  done
done
date -u +"%Y-%m-%dT%H:%M:%SZ" > "$DIR/captured-at.txt"
echo "capture -> $DIR"
