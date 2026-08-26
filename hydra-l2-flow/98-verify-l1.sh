#!/usr/bin/env bash
# Report L1 balances of the three fund destinations after fanout.
set -euo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
KEY="$(cat "$REPO/hydra-l2-flow/preprod/blockfrost.txt")"
declare -a PAIRS=(
  "buyer-db-wallet addr_test1qqhpyjqcq4u49rlp6gag57xq0xkvsu36q9n0z7j7vd5re38yhrczecm8dtse0rzhqcmnfu9zkymtjvtjp4fn365d3dyq8p9het"
  "seller-db-wallet addr_test1qpukmaupwm9e5wccytz4l53hgh5qdvvz4cxmqm62a6h75wka08uf8taezqr6tjd0s2y8swqex57zjq0y7w3dkkh9exvs62g255"
  "purchasing-file addr_test1vr0k7n76m2s9gsnha2n47umajyuwhe3rqsr7pnh2cgfc7yg60l8fh"
)
for pair in "${PAIRS[@]}"; do
  name="${pair%% *}"; addr="${pair##* }"
  total=$(curl -s "https://cardano-preprod.blockfrost.io/api/v0/addresses/$addr" -H "project_id: $KEY" | jq -r 'if .amount then ([.amount[] | select(.unit=="lovelace") | .quantity] | first // "0") else "0" end')
  printf "%-18s %s  %.6f ADA\n" "$name" "${addr:0:24}…" "$(echo "$total / 1000000" | bc -l)"
done
