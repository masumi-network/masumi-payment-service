#!/usr/bin/env bash
#
# 18-settlement-run.sh — Milestone 4 settlement verification on preprod.
# HEADS heads in sequence; each head runs DEPOSITS deposits, WITHDRAWALS
# withdrawals, one Close and one Fanout through the payment service's API.
# Default 5 x (4 + 4 + 2) = 50 consecutive settlement transactions.
#
# Resumable: heads whose fanout row already exists in the ledger are skipped.
# A failed cycle stops the run — "consecutive" means the count restarts from a
# clean ledger, so fix the cause, move the ledger aside, and start over.
#
# Usage: ./hydra-l2-flow/18-settlement-run.sh            # all heads
#        HEADS=1 DEPOSITS=1 WITHDRAWALS=1 ./hydra-l2-flow/18-settlement-run.sh   # dry run
#        HEADS=2 DEPOSITS=2 WITHDRAWALS=21 DEPOSIT_LOVELACE=40000000 WITHDRAW_LOVELACE=3500000 ./hydra-l2-flow/18-settlement-run.sh   # 50 txs in ~5 h
set -uo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO" || exit 1

HEADS="${HEADS:-5}"
DEPOSITS="${DEPOSITS:-4}"
WITHDRAWALS="${WITHDRAWALS:-4}"
COMMIT_ADA="${COMMIT_ADA:-110}"
# The full run uses fewer, larger deposits and many small withdrawals because
# a withdrawal settles in ~5 minutes while a deposit needs the activation
# delay; the last withdrawal of a head always drains.
DEPOSIT_LOVELACE="${DEPOSIT_LOVELACE:-10500000}"
WITHDRAW_LOVELACE="${WITHDRAW_LOVELACE:-8000000}"
# hydra-node 2.4.1 cannot read upstream's preprod script publication through
# Blockfrost (AssetNameMissing); this is the self-published set from the
# 2026-09-07 run, verified unspent. Not stored anywhere else in the repo.
export HYDRA_SCRIPTS_TX_IDS="${HYDRA_SCRIPTS_TX_IDS:-23fcc236c21040cd4e87324203e993493941a2eb311ccf21e8f0ada9c6383c43,4814062d4f8b61510308088815a5ddaa365eef4f59b2bc649d21def533114cf8}"
# 600 s is what the service assumes for preprod (defaultPeriodsFor), so the
# topup rows' usableFrom/absorbBy are truthful, and the increment window is
# wide enough to survive the Blockfrost chain-follower lag. Activation
# defaults to the period inside hydra-native.sh.
export DEPOSIT_PERIOD="${DEPOSIT_PERIOD:-600s}"
# Activation is the node's own delay before a recorded deposit may be
# absorbed, separate from the period that sizes the window; 120 s keeps the
# 600 s window and cuts a deposit from ~15 to ~7 minutes.
export DEPOSIT_ACTIVATION="${DEPOSIT_ACTIVATION:-120s}"
NODE1="${NODE1:-http://127.0.0.1:4001}"
EVIDENCE="$REPO/hydra-l2-flow/evidence/2026-m4-preprod/settlement"
LEDGER="$EVIDENCE/ledger.jsonl"
KEY_FILE="$REPO/hydra-l2-flow/.native-state/m4-api-key.txt"
DB_URL='postgresql://postgres:testpass@localhost:5434/masumi_hydra_test?schema=public'
SERVICE_LOG="$REPO/hydra-l2-flow/.native-state/m4-service.log"
mkdir -p "$EVIDENCE" "$REPO/hydra-l2-flow/.native-state"

blue(){ printf '\033[36m%s\033[0m\n' "$*"; }
green(){ printf '\033[32m%s\033[0m\n' "$*"; }
red(){ printf '\033[31m%s\033[0m\n' "$*"; }

head_done(){ # $1 = head index; true when its fanout row is in the ledger
  [ -f "$LEDGER" ] && jq -e --argjson i "$1" 'select(.headIndex==$i and .kind=="fanout")' "$LEDGER" >/dev/null 2>&1
}

service_stop(){
  # pnpm exec tsx spawns pnpm -> tsx cli -> node loader; pkill -f only matches
  # the pnpm wrapper's argv, so a surviving child stays bound to the previous
  # head's DB and would pass the next head's health check while stale. Kill by
  # listening PID first, then sweep with the old pkill, then confirm the port
  # is actually free before declaring success.
  lsof -tiTCP:3011 -sTCP:LISTEN 2>/dev/null | xargs -r kill 2>/dev/null
  pkill -f 'tsx ./src/index.ts' 2>/dev/null
  for _ in $(seq 1 15); do
    lsof -tiTCP:3011 -sTCP:LISTEN >/dev/null 2>&1 || return 0
    sleep 1
  done
  red "service_stop: something is still listening on :3011"; return 1
}

service_start(){
  service_stop || return 1
  ( set -a; source "$REPO/.env.hydra-demo"; set +a; nohup pnpm exec tsx ./src/index.ts >"$SERVICE_LOG" 2>&1 & )
  for _ in $(seq 1 45); do curl -sf http://127.0.0.1:3011/api/v1/health >/dev/null 2>&1 && return 0; sleep 2; done
  red "service did not become healthy — see $SERVICE_LOG"; return 1
}

wait_head_open(){
  for _ in $(seq 1 30); do
    local s; s="$(curl -s -H "token: $(cat "$KEY_FILE")" 'http://127.0.0.1:3011/api/v1/hydra/head?network=Preprod' | jq -r '.data.heads[0].status')"
    [ "$s" = "Open" ] && return 0
    sleep 5
  done
  red "head never reported Open through the service"; return 1
}

# 00-open-head.mts re-drafts a second deposit when it cannot see its first one
# on chain in time, and a stray pending deposit competes with every topup for
# the node's fee UTxO (both increments then fail and expire — seen 2026-09-17).
# Refuse to start a cycle while the node still lists a pending deposit; once
# its deadline has passed, recover it with the node's own recover call.
ensure_no_pending_deposits(){
  local i pending
  for i in $(seq 1 40); do   # up to ~40 min: a 600 s-period deposit's deadline is 30 min out
    pending="$(curl -s --max-time 8 "$NODE1/head" | jq -r '[.. | objects | select(has("pendingDeposits")) | .pendingDeposits | keys[]] | unique | .[]' 2>/dev/null)"
    [ -z "$pending" ] && return 0
    local d
    for d in $pending; do
      blue "  pending deposit $d — recovering (no-op until its deadline has passed)"
      curl -s -X DELETE "$NODE1/commits/$d" >/dev/null 2>&1 || true
    done
    sleep 60
  done
  red "a deposit is still pending after 40 min: $pending"; return 1
}

# The node posts Increment, Decrement, Close and Fanout from its own key and
# fails with NoCollateralInputs when that key has no confirmed pure-ADA UTxO.
ensure_node_fuel(){
  # The harness runs the purchasing node on a fixed key, so its enterprise
  # address is constant; check-preprod-balances.mts prints it first.
  local addr ada
  addr="$(pnpm exec tsx hydra-l2-flow/check-preprod-balances.mts 2>/dev/null | grep -oE 'addr_test1v[a-z0-9]+' | head -1)"
  [ -n "$addr" ] || addr="addr_test1vqau6vf2cc0p4s409yuyy4ep0nl0ax7zh3dj0vt4dlvtfmq48yln5"
  ada="$(curl -s -H "project_id: $(cat "$REPO/hydra-l2-flow/preprod/blockfrost.txt")" \
    "https://cardano-preprod.blockfrost.io/api/v0/addresses/$addr/utxos?count=50" \
    | jq '[.[] | select(all(.amount[]; .unit=="lovelace")) | (.amount[0].quantity|tonumber)] | max // 0 | ./1000000')"
  blue "  node key $addr largest pure-ADA UTxO: ${ada} ADA"
  awk -v a="$ada" 'BEGIN{exit !(a>=20)}' || { red "  node key needs a confirmed pure-ADA UTxO of at least 20 ADA for fees and collateral"; return 1; }
}

# Sourced with M4_SOURCE_ONLY=1, this file only defines its settings and
# functions so another evidence run can open a head exactly the same way
# without running a settlement cycle. `return` works when sourced; the
# `exit` covers someone executing the file with the variable set.
if [ "${M4_SOURCE_ONLY:-0}" = 1 ]; then return 0 2>/dev/null || exit 0; fi

for i in $(seq 1 "$HEADS"); do
  if head_done "$i"; then blue "[head $i] already complete — skipping"; continue; fi
  blue "[head $i/$HEADS] fresh database + fresh head"
  service_stop || exit 1
  docker rm -f masumi-hydra-bench-db >/dev/null 2>&1
  ./hydra-l2-flow/replicate-benchmark.sh db || { red "db stage failed"; exit 1; }
  DATABASE_URL="$DB_URL" pnpm exec tsx hydra-l2-flow/mint-bench-api-key.mts | tail -1 > "$KEY_FILE"
  if [ ! -s "$KEY_FILE" ] || ! grep -qE '^[A-Za-z0-9_]{8,}$' "$KEY_FILE"; then
    red "api key mint failed"; exit 1
  fi
  COMMIT_ADA="$COMMIT_ADA" ./hydra-l2-flow/replicate-benchmark.sh head || { red "head stage failed"; exit 1; }
  ensure_no_pending_deposits || exit 1
  ensure_node_fuel || exit 1
  service_start || exit 1
  wait_head_open || exit 1

  blue "[head $i] cycle: $DEPOSITS deposits, $WITHDRAWALS withdrawals, close, fanout"
  if ! pnpm exec tsx hydra-l2-flow/18-settlement-cycle.mts --head-index "$i" --deposits "$DEPOSITS" --withdrawals "$WITHDRAWALS" --ledger "$LEDGER" --lovelace "$DEPOSIT_LOVELACE" --withdraw-lovelace "$WITHDRAW_LOVELACE"; then
    red "[head $i] cycle FAILED — run stopped. The ledger is no longer a consecutive series."
    exit 1
  fi

  local_head_id="$(jq -r --argjson i "$i" 'select(.headIndex==$i and .kind=="fanout") | .headIdentifier' "$LEDGER" | tail -1)"
  mkdir -p "$EVIDENCE/head-$i"
  pnpm exec tsx hydra-l2-flow/17-record-l1-anchors.mts --head-id "$local_head_id" --out "$EVIDENCE/head-$i/l1-anchors.json" \
    || red "[head $i] anchors incomplete — Task 4 will report the gap"
  green "[head $i] done"
done

service_stop
total="$(wc -l < "$LEDGER" | tr -d ' ')"
green "=== run complete: $total settlement transactions in $LEDGER ==="
