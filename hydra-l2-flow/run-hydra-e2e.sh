#!/usr/bin/env bash
#
# run-hydra-e2e.sh — one-command driver for the Masumi V2 Hydra L2 escrow E2E.
#
# Bundles devnet bring-up + test DB + head open/fund and the seven escrow
# operations into subcommands. Every step runs Masumi's OWN service code against
# a LIVE hydra-node; the head's `TxValid` log + its /snapshot/utxo HTTP API are
# the ground-truth "actual data". See README.md in this folder for the full
# prerequisites + walkthrough.
#
# Usage:
#   ./run-hydra-e2e.sh up        # devnet + test DB + open & fund a head   (run once)
#   ./run-hydra-e2e.sh all       # up → flow2 → flow1 → flow3 (full lifecycle, ~30 min)
#   ./run-hydra-e2e.sh flow1     # happy path : lock → submit → collection (seller paid)
#   ./run-hydra-e2e.sh flow2     # refund path: lock → request → authorize → collect (buyer refunded)
#   ./run-hydra-e2e.sh flow3     # dispute    : lock → submit → request(→Disputed) → authorize-withdrawal
#   ./run-hydra-e2e.sh verify    # print last head verdict + in-head escrow UTxOs
#   ./run-hydra-e2e.sh fund      # top the buyer/seller back up inside the head
#   ./run-hydra-e2e.sh down      # stop the devnet + remove the test DB
#
# Flows 1 and 3 include the contract's own cooldown waits (~10–16 min) — that is
# correct on-chain behaviour, not a hang. Flow 2 has no waits.
#
# Prerequisites (see README.md):
#   - Docker running.
#   - The cardano-scaling/hydra `demo/` checked out, patched per README, and its
#     path exported as HYDRA_DEMO_DIR (or DEMO). Defaults to ../../../hydra/demo
#     relative to the repo if present.
set -uo pipefail

# ── Config (override via env) ────────────────────────────────────────────────
# REPO is derived from this script's location (…/<repo>/hydra-l2-flow/run-hydra-e2e.sh).
REPO="${REPO:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
# Path to the external cardano-scaling/hydra demo dir. Prefer HYDRA_DEMO_DIR;
# fall back to a sibling checkout next to the repo, else error in preflight.
DEMO="${DEMO:-${HYDRA_DEMO_DIR:-$(cd "$REPO/../.." 2>/dev/null && pwd)/hydra/demo}}"
DB_CONTAINER="${DB_CONTAINER:-masumi-hydra-test-db}"
export DATABASE_URL="${DATABASE_URL:-postgresql://postgres:testpass@localhost:5433/masumi_hydra_test?schema=public}"
NODE1="${NODE1:-http://localhost:4001}"
CARDANO_CONTAINER="${CARDANO_CONTAINER:-demo-cardano-node-1}"
HYDRA_NODE_CONTAINER="${HYDRA_NODE_CONTAINER:-demo-hydra-node-1-1}"
HYDRA_IMAGE="${HYDRA_IMAGE:-ghcr.io/cardano-scaling/hydra-node:2.1.0}"

cd "$REPO" || { echo "repo not found: $REPO"; exit 1; }

c_grn(){ printf '\033[32m%s\033[0m\n' "$*"; }
c_red(){ printf '\033[31m%s\033[0m\n' "$*"; }
c_blu(){ printf '\033[36m%s\033[0m\n' "$*"; }

# Fail fast with actionable guidance if the environment isn't ready.
preflight(){
  local ok=1
  command -v docker >/dev/null 2>&1 || { c_red "missing: docker (is Docker running?)"; ok=0; }
  command -v pnpm   >/dev/null 2>&1 || { c_red "missing: pnpm"; ok=0; }
  command -v node   >/dev/null 2>&1 || { c_red "missing: node"; ok=0; }
  if [ ! -d "$DEMO" ]; then
    c_red "Hydra demo dir not found: $DEMO"
    c_red "  Clone cardano-scaling/hydra, patch its devnet genesis per README.md,"
    c_red "  then re-run with:  HYDRA_DEMO_DIR=/path/to/hydra/demo $0 $*"
    ok=0
  fi
  [ "$ok" = 1 ] || exit 1
}

# Live devnet tip slot.
tip_slot(){ docker exec "$CARDANO_CONTAINER" bash -c \
  'export CARDANO_NODE_SOCKET_PATH=/devnet/node.socket; cardano-cli query tip --testnet-magic 42' 2>/dev/null \
  | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>console.log(JSON.parse(d).slot))"; }

# Genesis systemStart (ms) — slot-context anchor.
zero_time(){ node -e "console.log(Date.parse(require('$DEMO/devnet/genesis-shelley.json').systemStart))"; }

# Point the L2 slot context at the live head clock. Call before every step.
slotenv(){
  export HYDRA_L2_SLOT_ZERO_TIME_MS="$(zero_time)"
  export HYDRA_L2_SLOT_LENGTH_MS=1000
  export HYDRA_L2_CURRENT_SLOT="$(tip_slot)"
}

# No tx-sync runs in the harness → unlock hot wallets between manual steps.
unlock(){ docker exec "$DB_CONTAINER" psql -U postgres -d masumi_hydra_test \
  -c 'UPDATE "HotWallet" SET "lockedAt"=NULL, "pendingTransactionId"=NULL;' >/dev/null 2>&1; }

# Run a tsx flow script with a timeout (these scripts can leave an open handle
# on exit). Streams output; returns the script's PASS/FAIL line.
run_tsx(){
  local script="$1"; shift
  local timeout_s="${RUN_TIMEOUT:-120}"
  local out; out="$(mktemp)"
  pnpm exec tsx "$script" >"$out" 2>&1 &
  local pid=$!
  local i=0
  while kill -0 "$pid" 2>/dev/null; do
    [ "$i" -ge "$timeout_s" ] && { kill "$pid" 2>/dev/null; break; }
    sleep 1; i=$((i+1))
  done
  grep -iE "PASSED|did not|ERROR DETAIL|repointed|created" "$out" | head -6
  cat "$out" >> /tmp/hydra-e2e.log
  rm -f "$out"
}

verdict(){ docker logs "$HYDRA_NODE_CONTAINER" 2>&1 \
  | grep -oE '"tag":"(TxValid|TxInvalid)"|OutsideValidityIntervalUTxO|OutsideForecast|PPViewHashesDontMatch' | tail -1; }

# ── up : devnet + test DB + open & fund a head ───────────────────────────────
cmd_up(){
  c_blu "[1/5] Hydra devnet…"
  if docker compose -f "$DEMO/docker-compose.yaml" ps 2>/dev/null | grep -q "hydra-node-1"; then
    c_grn "  already running"
  else
    ( cd "$DEMO" && ./prepare-devnet.sh && docker compose up -d cardano-node )
    for i in $(seq 1 40); do [ -S "$DEMO/devnet/node.socket" ] && break; sleep 1; done
    ( cd "$DEMO" && ./seed-devnet.sh )
    local txid; txid="$(docker run --rm -v "$DEMO/devnet:/devnet" "$HYDRA_IMAGE" -- \
      publish-scripts --testnet-magic 42 --node-socket /devnet/node.socket \
      --cardano-signing-key /devnet/credentials/faucet.sk 2>/dev/null | tail -1)"
    printf 'HYDRA_SCRIPTS_TX_ID=%s\n' "$txid" > "$DEMO/.env"
    ( cd "$DEMO" && docker compose up -d hydra-node-1 hydra-node-2 hydra-node-3 )
    sleep 8
  fi
  curl -s "$NODE1/protocol-parameters" >/dev/null 2>&1 && c_grn "  head API up" || { c_red "  head API down"; exit 1; }

  c_blu "[2/5] Test DB on 5433 (dev DB on 5432 untouched)…"
  if docker ps -a --format '{{.Names}}' | grep -q "^${DB_CONTAINER}$"; then
    docker start "$DB_CONTAINER" >/dev/null 2>&1; c_grn "  reusing existing DB"
  else
    docker run -d --name "$DB_CONTAINER" -e POSTGRES_PASSWORD=testpass \
      -e POSTGRES_DB=masumi_hydra_test -p 5433:5432 postgres:15 >/dev/null
    for i in $(seq 1 30); do docker exec "$DB_CONTAINER" pg_isready -U postgres >/dev/null 2>&1 && break; sleep 1; done
    npx prisma migrate deploy --config prisma/prisma.config.ts
    npx prisma db seed --config prisma/prisma.config.ts
  fi

  c_blu "[3/5] Open head + commit 100 ADA (deposit finalizes in ~2 min)…"
  RUN_TIMEOUT=150 run_tsx hydra-l2-flow/00-open-head.mts
  c_blu "      waiting for the in-head deposit to incorporate…"
  for i in $(seq 1 24); do
    local n; n=$(curl -s "$NODE1/snapshot/utxo" | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>console.log(Object.keys(JSON.parse(d)).length))" 2>/dev/null)
    [ "${n:-0}" -ge 1 ] && { c_grn "  funds in head ($n UTxO)"; break; }
    sleep 10
  done

  c_blu "[4/5] Derive buyer address + fund buyer (80 ADA in head)…"
  local wout; wout="$(mktemp)"
  RUN_TIMEOUT=40 pnpm exec tsx hydra-l2-flow/01-wallet.mts >"$wout" 2>&1 &
  local wp=$!; for i in $(seq 1 40); do kill -0 $wp 2>/dev/null || break; sleep 1; done; kill $wp 2>/dev/null
  BUYER="$(grep -oE 'addr_test1q[a-z0-9]+' "$wout" | head -1)"; rm -f "$wout"
  [ -n "$BUYER" ] || { c_red "  could not derive buyer address"; exit 1; }
  echo "  buyer = ${BUYER:0:24}…"
  RUN_TIMEOUT=40 run_tsx "hydra-l2-flow/02-fund-in-head.mts" "$BUYER" 80000000

  c_blu "[5/5] Give the seller a base address + fund seller (25 ADA in head)…"
  RUN_TIMEOUT=40 run_tsx hydra-l2-flow/04-fix-seller.mts
  SELLER="$(node -e "console.log(require('$REPO/hydra-l2-flow/.seller.json').address)")"
  echo "  seller = ${SELLER:0:24}…"
  RUN_TIMEOUT=40 run_tsx "hydra-l2-flow/02-fund-in-head.mts" "$SELLER" 25000000

  c_grn "=== UP: head open + funded, test DB seeded. Run: $0 flow1|flow2|flow3 ==="
}

# Top buyer/seller back up from alice's remaining in-head balance.
cmd_fund(){
  local wout; wout="$(mktemp)"
  RUN_TIMEOUT=40 pnpm exec tsx hydra-l2-flow/01-wallet.mts >"$wout" 2>&1 &
  local wp=$!; for i in $(seq 1 40); do kill -0 $wp 2>/dev/null || break; sleep 1; done; kill $wp 2>/dev/null
  BUYER="$(grep -oE 'addr_test1q[a-z0-9]+' "$wout" | head -1)"; rm -f "$wout"
  SELLER="$(node -e "console.log(require('$REPO/hydra-l2-flow/.seller.json').address)" 2>/dev/null)"
  c_blu "topping up buyer…"; RUN_TIMEOUT=40 run_tsx "hydra-l2-flow/02-fund-in-head.mts" "$BUYER" "${1:-15000000}"
  [ -n "$SELLER" ] && { c_blu "topping up seller…"; RUN_TIMEOUT=40 run_tsx "hydra-l2-flow/02-fund-in-head.mts" "$SELLER" "${2:-10000000}"; }
}

step(){ # step <label> <script> [extra env already exported]
  unlock; slotenv
  c_blu "── $1 (slot $HYDRA_L2_CURRENT_SLOT)"
  run_tsx "$2"
  c_grn "   head verdict: $(verdict)"
}

# ── flow1 : happy path (seller paid) ─────────────────────────────────────────
cmd_flow1(){
  # past unlock so collection is reachable; future submit window.
  export LOCK_LOVELACE=10000000 SUBMIT_RESULT_OFFSET_MS=360000 UNLOCK_OFFSET_MS=-1200000 \
         DISPUTE_OFFSET_MS=1800000 PAYBY_OFFSET_MS=120000
  step "lock"           hydra-l2-flow/03-lock.mts
  step "submit-result"  hydra-l2-flow/06-submit-result.mts
  c_blu "── collection waits the contract seller-cooldown (~13 min)…"
  sleep 800
  step "collection"     hydra-l2-flow/07-collection.mts
  c_grn "=== FLOW1 done (lock → submit-result → collection) ==="
}

# ── flow2 : refund path (buyer refunded, no waits) ───────────────────────────
cmd_flow2(){
  unset SUBMIT_RESULT_OFFSET_MS UNLOCK_OFFSET_MS DISPUTE_OFFSET_MS PAYBY_OFFSET_MS REQUEST_REFUND_FROM_STATE
  export LOCK_LOVELACE=10000000
  step "lock"             hydra-l2-flow/03-lock.mts
  step "request-refund"   hydra-l2-flow/08-request-refund.mts
  step "authorize-refund" hydra-l2-flow/09-authorize-refund.mts
  step "collect-refund"   hydra-l2-flow/10-collect-refund.mts
  c_grn "=== FLOW2 done (lock → request → authorize → collect-refund) ==="
}

# ── flow3 : dispute → authorize-withdrawal ───────────────────────────────────
cmd_flow3(){
  unset SUBMIT_RESULT_OFFSET_MS UNLOCK_OFFSET_MS DISPUTE_OFFSET_MS PAYBY_OFFSET_MS
  export LOCK_LOVELACE=10000000
  step "lock"            hydra-l2-flow/03-lock.mts
  step "submit-result"   hydra-l2-flow/06-submit-result.mts
  export REQUEST_REFUND_FROM_STATE=ResultSubmitted
  step "request-refund→Disputed" hydra-l2-flow/08-request-refund.mts
  unset REQUEST_REFUND_FROM_STATE
  c_blu "── authorize-withdrawal waits the contract buyer-cooldown (~16 min)…"
  sleep 1000
  step "authorize-withdrawal" hydra-l2-flow/11-authorize-withdrawal.mts
  c_grn "=== FLOW3 done (lock → submit → request(→Disputed) → authorize-withdrawal) ==="
}

# ── all : full lifecycle (fast refund path first, then the two cooldown flows) ─
cmd_all(){
  cmd_up
  c_blu "═══ FLOW 2 (refund path, no waits) ═══"; cmd_flow2
  cmd_fund
  c_blu "═══ FLOW 1 (happy path, ~13 min cooldown) ═══"; cmd_flow1
  cmd_fund
  c_blu "═══ FLOW 3 (dispute path, ~16 min cooldown) ═══"; cmd_flow3
  c_grn "=== ALL FLOWS DONE — run '$0 verify' for the final head state ==="
}

# ── verify : ground-truth head state ─────────────────────────────────────────
cmd_verify(){
  c_blu "Last head verdict:"; echo "  $(verdict)"
  c_blu "In-head escrow (script) UTxOs:"
  curl -s "$NODE1/snapshot/utxo" | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{const u=JSON.parse(d);let any=false;
    for(const k of Object.keys(u)){const x=u[k]; if(x.address.startsWith('addr_test1wq')){any=true;console.log('  '+k.slice(0,18)+'… '+x.value.lovelace+' lovelace  datum:'+(x.inlineDatum?'yes':'no'));}}
    if(!any)console.log('  (none — funds collected/refunded out)');})"
  c_blu "Recent head TxValid count:"; echo "  $(docker logs "$HYDRA_NODE_CONTAINER" 2>&1 | grep -c '"tag":"TxValid"')"
}

# ── down ─────────────────────────────────────────────────────────────────────
cmd_down(){
  ( cd "$DEMO" && docker compose down )
  docker rm -f "$DB_CONTAINER" >/dev/null 2>&1
  c_grn "=== devnet stopped, test DB removed (dev DB on 5432 untouched) ==="
}

case "${1:-}" in
  up)     preflight "$@"; cmd_up ;;
  all)    preflight "$@"; cmd_all ;;
  flow1)  preflight "$@"; cmd_flow1 ;;
  flow2)  preflight "$@"; cmd_flow2 ;;
  flow3)  preflight "$@"; cmd_flow3 ;;
  fund)   preflight "$@"; cmd_fund "${2:-}" "${3:-}" ;;
  verify) cmd_verify ;;
  down)   cmd_down ;;
  *) grep -E '^#( |$)' "$0" | sed -n '2,28p' | sed 's/^# \{0,1\}//'; exit 1 ;;
esac
