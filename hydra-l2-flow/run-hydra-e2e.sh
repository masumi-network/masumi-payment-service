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
#   ./run-hydra-e2e.sh demo      # ONE-SHOT DEMO: up → all 7 ops with LIVE logs (~30 min)
#   ./run-hydra-e2e.sh all       # up → flow2 → flow1 → flow3 (full lifecycle, ~30 min)
#   ./run-hydra-e2e.sh flow1     # happy path : lock → submit → collection (seller paid)
#   ./run-hydra-e2e.sh flow2     # refund path: lock → request → authorize → collect (buyer refunded)
#   ./run-hydra-e2e.sh flow3     # dispute    : lock → submit → request(→Disputed) → authorize-withdrawal
#   ./run-hydra-e2e.sh verify    # print last head verdict + in-head escrow UTxOs
#   ./run-hydra-e2e.sh fund      # top the buyer/seller back up inside the head
#   ./run-hydra-e2e.sh evidence  # render the per-op proof report (hash↔node-log↔DB) for devs
#   ./run-hydra-e2e.sh settle    # Close → Fanout: settle in-head balances back to L1 (run LAST)
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
DEMO="${DEMO:-${HYDRA_DEMO_DIR:-$( \
  for d in "$REPO/../hydra/demo" "$REPO/../../hydra/demo"; do \
    [ -d "$d" ] && { (cd "$d" && pwd); break; }; \
  done )}}"
DB_CONTAINER="${DB_CONTAINER:-masumi-hydra-test-db}"
export DATABASE_URL="${DATABASE_URL:-postgresql://postgres:testpass@localhost:5433/masumi_hydra_test?schema=public}"
# 127.0.0.1, not localhost: the native hydra-node binds its API to 127.0.0.1,
# and on macOS `localhost` resolves to IPv6 ::1 first — curl then fails to
# connect (the node isn't listening on ::1) and the head reads as "down".
NODE1="${NODE1:-http://127.0.0.1:4001}"
CARDANO_CONTAINER="${CARDANO_CONTAINER:-demo-cardano-node-1}"
HYDRA_NODE_CONTAINER="${HYDRA_NODE_CONTAINER:-demo-hydra-node-1-1}"
HYDRA_IMAGE="${HYDRA_IMAGE:-ghcr.io/cardano-scaling/hydra-node:2.2.0}"
TSX="${TSX:-$REPO/node_modules/.bin/tsx}"

# Hydra 2.2.0 added a Rust BLS accumulator (Partial Fanout). The published
# linux/amd64 images run under Docker Desktop's Rosetta on Apple Silicon, where
# that native crypto pegs a core at 100% CPU and never finishes — publish-scripts
# and even node startup hang. So on arm64 macOS we run the hydra-nodes NATIVELY
# (see hydra-native.sh); cardano-node stays in Docker. Override with HYDRA_NATIVE.
if [ -z "${HYDRA_NATIVE:-}" ]; then
  if [ "$(uname -s)" = "Darwin" ] && [ "$(uname -m)" = "arm64" ]; then HYDRA_NATIVE=1; else HYDRA_NATIVE=0; fi
fi
NETWORK="${NETWORK:-devnet}"
export NETWORK
export HYDRA_FLOW_NETWORK="$NETWORK"
NATIVE_SH="$REPO/hydra-l2-flow/hydra-native.sh"
NATIVE_STATE="$REPO/hydra-l2-flow/.native-state"
NATIVE_LOG="$NATIVE_STATE/node1.log"
NATIVE_BIN="${NATIVE_BIN:-$REPO/hydra-l2-flow/.bin/hydra-node}"

# Per-op evidence ledger. step() appends one TSV row per escrow operation as it
# runs (op<TAB>headTxId<TAB>masumiDbHash<TAB>match<TAB>slot<TAB>iso8601). The
# `evidence` subcommand renders it into a developer-facing report with node-log
# + DB + in-head correlation and copy-paste self-verify commands.
EVIDENCE_TSV="${EVIDENCE_TSV:-$REPO/hydra-l2-flow/.native-state/evidence.tsv}"
# Settlement facts written by the settle step; build-evidence folds them into EVIDENCE.md.
SETTLEMENT_STATE="${SETTLEMENT_STATE:-$REPO/hydra-l2-flow/.native-state/settlement.json}"

# hydra-node-1's log source — a docker container (emulated path) or the native
# node1 logfile (native path). Used by verdict()/verify().
node1_logs(){
  if [ "$HYDRA_NATIVE" = 1 ]; then cat "$NATIVE_LOG" 2>/dev/null; else docker logs "$HYDRA_NODE_CONTAINER" 2>&1; fi
}

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
  if [ "$NETWORK" != preprod ] && [ ! -d "$DEMO" ]; then
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
  if [ "$NETWORK" = preprod ]; then
    # Use the HEAD's observed tip slot (the node's L1 view), NOT Blockfrost's tip.
    # Over Blockfrost the node lags the real tip by ~100 slots, so building L2 tx
    # validity intervals from Blockfrost's (ahead) slot puts them in the head's
    # future → OutsideValidityIntervalUTxO. The head validates against its own
    # observed slot, so read that from the latest Tick in node1's log.
    local slot; slot="$(grep -a '"tag":"Tick"' "$NATIVE_LOG" 2>/dev/null | tail -1 | grep -oE '"slot":[0-9]+' | head -1 | grep -oE '[0-9]+')"
    if [ -z "$slot" ]; then
      local KEY; KEY="$(cat "$REPO/hydra-l2-flow/preprod/blockfrost.txt")"
      slot="$(curl -s "https://cardano-preprod.blockfrost.io/api/v0/blocks/latest" -H "project_id: $KEY" \
        | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>console.log(JSON.parse(d).slot))")"
    fi
    # Effective slot-zero for preprod Shelley-era slots (1s slots). Derived from a
    # live block: zero = block.time - block.slot = 1655683200 s (2022-06-20T00:00:00Z),
    # which equals preprod Shelley-start (1655769600) minus the 86400 Byron slots.
    # The old value (1648771200000, 2022-04-01) was wrong by ~80 days, so every L2
    # script tx's validity interval landed ~80 days in the head's past →
    # OutsideValidityIntervalUTxO on lock/submit-result. See BLOCKFROST-PLAN.md.
    export HYDRA_L2_SLOT_ZERO_TIME_MS=1655683200000
    export HYDRA_L2_SLOT_LENGTH_MS=1000
    export HYDRA_L2_CURRENT_SLOT="$slot"
    return
  fi
  export HYDRA_L2_SLOT_ZERO_TIME_MS="$(zero_time)"
  export HYDRA_L2_SLOT_LENGTH_MS=1000
  export HYDRA_L2_CURRENT_SLOT="$(tip_slot)"
}

# No tx-sync runs in the harness → unlock hot wallets between manual steps.
unlock(){ docker exec "$DB_CONTAINER" psql -U postgres -d masumi_hydra_test \
  -c 'UPDATE "HotWallet" SET "lockedAt"=NULL, "pendingTransactionId"=NULL;' >/dev/null 2>&1; }

# Run a tsx flow script with a timeout (these scripts can leave an open handle
# on exit). Forwards any extra args ("$@") to the script. In VERBOSE=1 mode the
# full output is streamed live (for demos); otherwise only the PASS/FAIL summary
# lines are shown and full output is appended to /tmp/hydra-e2e.log.
run_tsx(){
  local script="$1"; shift
  local timeout_s="${RUN_TIMEOUT:-120}"
  local out; out="$(mktemp)"
  if [ "${VERBOSE:-0}" = 1 ]; then
    # Stream full output to the terminal AND capture it; watchdog enforces timeout.
    "$TSX" "$script" "$@" 2>&1 | tee "$out" &
    local pid=$!
    ( sleep "$timeout_s"; kill "$pid" 2>/dev/null ) >/dev/null 2>&1 &
    local wd=$!
    wait "$pid" 2>/dev/null
    kill "$wd" 2>/dev/null
  else
    "$TSX" "$script" "$@" >"$out" 2>&1 &
    local pid=$!
    local i=0
    while kill -0 "$pid" 2>/dev/null; do
      [ "$i" -ge "$timeout_s" ] && { kill "$pid" 2>/dev/null; break; }
      sleep 1; i=$((i+1))
    done
    grep -iE "PASSED|did not|ERROR DETAIL|repointed|created" "$out" | head -6
  fi
  cat "$out" >> /tmp/hydra-e2e.log
  rm -f "$out"
}

# Visible countdown for the contract cooldowns (so a long sleep doesn't look
# like a hang during a live demo).
countdown(){
  local secs="$1" label="${2:-cooldown}"
  while [ "$secs" -gt 0 ]; do
    printf '\r   \033[36m%s: %4ds remaining…\033[0m' "$label" "$secs"
    sleep 5; secs=$((secs-5))
  done
  printf '\r   \033[32m%s: done.                 \033[0m\n' "$label"
}

# Big stage banner for the demo.
banner(){ printf '\n\033[1;35m══════════════════════════════════════════════════════════\n  %s\n══════════════════════════════════════════════════════════\033[0m\n' "$*"; }

verdict(){ node1_logs \
  | grep -oE '"tag":"(TxValid|TxInvalid)"|OutsideValidityIntervalUTxO|OutsideForecast|PPViewHashesDontMatch' | tail -1; }

# Current node1 log length (works native: cat logfile; docker: full `docker logs`).
nlog_len(){ node1_logs 2>/dev/null | wc -l | tr -d ' '; }

# Newest L2 tx hash Masumi recorded — the hash a step's own service produced.
latest_l2_hash(){ docker exec "$DB_CONTAINER" psql -U postgres -d masumi_hydra_test -t \
  -c 'SELECT "txHash" FROM "Transaction" WHERE layer='"'"'L2'"'"' AND "txHash" IS NOT NULL ORDER BY "createdAt" DESC LIMIT 1;' \
  2>/dev/null | tr -d '[:space:]'; }

# The single TxValid id the head emitted since log line $1 (this step's real
# head tx), or empty if the step put nothing into the head.
head_tx_since(){ node1_logs 2>/dev/null | tail -n +"$(($1 + 1))" \
  | grep '"tag":"TxValid"' | grep -oE '"transactionId":"[0-9a-f]{64}"' \
  | grep -oE '[0-9a-f]{64}' | tail -1; }

# HONEST per-step verdict. Inspects ONLY the node1 log lines appended since the
# step started ($1 = pre-step line count) and reports the head's ACTUAL outcome
# for THIS step's tx: a real validated tx id, a concrete rejection reason, or
# "NO HEAD TX" when nothing reached the head. (The old verdict() grepped the
# whole log and printed a stale setup TxValid, so every step looked green even
# when its own tx never executed — see node-log/head/DB correlation findings.)
verdict_since(){
  local from="$1"
  local new; new="$(node1_logs 2>/dev/null | tail -n +"$((from + 1))")"
  local valid; valid="$(printf '%s\n' "$new" | grep '"tag":"TxValid"' \
    | grep -oE '"transactionId":"[0-9a-f]{64}"' | grep -oE '[0-9a-f]{64}' | tail -1)"
  if [ -n "$valid" ]; then
    local db; db="$(latest_l2_hash)"
    if [ "$db" = "$valid" ]; then
      printf 'TxValid %s…  (head id == Masumi DB hash ✓ — built by Masumi V2)' "${valid:0:16}"
    else
      printf 'TxValid %s…  (head accepted; Masumi DB hash=%s…)' "${valid:0:16}" "${db:0:16}"
    fi
    return
  fi
  local bad; bad="$(printf '%s\n' "$new" \
    | grep -oE 'TxInvalid|OutsideValidityIntervalUTxO|OutsideForecast|PPViewHashesDontMatch|ValueNotConservedUTxO|FeeTooSmallUTxO|BadInputsUTxO' \
    | tail -1)"
  if [ -n "$bad" ]; then printf 'FAIL: %s (step tx rejected by head)' "$bad"; return; fi
  printf 'NO HEAD TX — nothing this step reached the head (submit failed / no-op)'
}

# ── up (preprod) : preprod nodes + test DB + open & fund a head ──────────────
cmd_up_preprod(){
  c_blu "[1/5] Hydra preprod nodes (blockfrost)…"
  if curl -s "$NODE1/protocol-parameters" >/dev/null 2>&1; then
    c_grn "  already running"
  else
    NETWORK=preprod "$NATIVE_SH" up
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
  docker exec "$DB_CONTAINER" psql -U postgres -d masumi_hydra_test \
    -c 'UPDATE "PaymentSource" SET "cooldownTime"=60000;' >/dev/null 2>&1 \
    && c_grn "  cooldownTime set to 60s"
  RUN_TIMEOUT=40 run_tsx hydra-l2-flow/point-vault.mts

  c_blu "[3/5] Open head + commit purchasing wallet UTxO to preprod…"
  # 900s: 00-open-head now CONFIRMS the deposit tx landed on L1 (Blockfrost's
  # submit endpoint can silently drop an accepted tx) and re-drafts on expiry —
  # allow up to ~3 confirm/redraft rounds before the watchdog fires.
  RUN_TIMEOUT=900 run_tsx hydra-l2-flow/00-open-head.mts
  c_blu "      waiting for the in-head deposit to incorporate…"
  # Preprod: the node proposes the IncrementTx only once its (Blockfrost-lagged)
  # observed chain-time reaches deposit_inclusion + deposit-period (600s). With the
  # node's chain-time lagging real time by ~3-6 min, the deposit lands in the head
  # ~16-18 min after open-head returns. Wait up to ~25 min before funding.
  for i in $(seq 1 150); do
    local n; n=$(curl -s "$NODE1/snapshot/utxo" | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>console.log(Object.keys(JSON.parse(d)).length))" 2>/dev/null)
    [ "${n:-0}" -ge 1 ] && { c_grn "  funds in head ($n UTxO)"; break; }
    sleep 10
  done

  c_blu "[4/5] Derive buyer address + fund buyer (40 ADA in head)…"
  local wout; wout="$(mktemp)"
  RUN_TIMEOUT=40 pnpm exec tsx hydra-l2-flow/01-wallet.mts >"$wout" 2>&1 &
  local wp=$!; for i in $(seq 1 40); do kill -0 $wp 2>/dev/null || break; sleep 1; done; kill $wp 2>/dev/null
  BUYER="$(grep -oE 'addr_test1q[a-z0-9]+' "$wout" | head -1)"; rm -f "$wout"
  [ -n "$BUYER" ] || { c_red "  could not derive buyer address"; exit 1; }
  echo "  buyer = ${BUYER:0:24}…"
  RUN_TIMEOUT=90 run_tsx "hydra-l2-flow/02-fund-in-head.mts" "$BUYER" 40000000

  c_blu "[5/5] Give the seller a base address + fund seller (20 ADA in head)…"
  RUN_TIMEOUT=40 run_tsx hydra-l2-flow/04-fix-seller.mts
  SELLER="$(node -e "console.log(require('$REPO/hydra-l2-flow/.seller.json').address)")"
  echo "  seller = ${SELLER:0:24}…"
  RUN_TIMEOUT=90 run_tsx "hydra-l2-flow/02-fund-in-head.mts" "$SELLER" 20000000

  local sutxo; sutxo=$(curl -s "$NODE1/snapshot/utxo" | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{const u=JSON.parse(d);let n=0;for(const k of Object.keys(u))if(u[k].address==='$SELLER')n++;console.log(n);})" 2>/dev/null)
  if [ "${sutxo:-0}" -lt 1 ]; then
    c_red "  seller has NO in-head UTxO — funding failed (not enough ADA committed?)."
    exit 1
  fi
  c_grn "  seller funded ($sutxo in-head UTxO)"
  c_grn "=== UP (preprod): head open + funded, test DB seeded. Run: $0 flow1|flow2|flow3 ==="
}

# ── up : devnet + test DB + open & fund a head ───────────────────────────────
cmd_up(){
  [ "$NETWORK" = preprod ] && { cmd_up_preprod; return; }
  c_blu "[1/5] Hydra devnet…"
  if { [ "$HYDRA_NATIVE" = 1 ] && curl -s "$NODE1/protocol-parameters" >/dev/null 2>&1; } \
     || { [ "$HYDRA_NATIVE" != 1 ] && docker compose -f "$DEMO/docker-compose.yaml" ps 2>/dev/null | grep -q "hydra-node-1"; }; then
    c_grn "  already running"
  else
    ( cd "$DEMO" && ./prepare-devnet.sh && docker compose up -d --force-recreate cardano-node )
    local cardano_ready=0
    for _ in $(seq 1 120); do
      if docker exec "$CARDANO_CONTAINER" cardano-cli query tip \
        --testnet-magic 42 --socket-path /devnet/node.socket >/dev/null 2>&1; then
        cardano_ready=1
        break
      fi
      sleep 1
    done
    [ "$cardano_ready" = 1 ] && c_grn "  cardano-node ready" || { c_red "  cardano-node did not become queryable"; exit 1; }
    if [ "$HYDRA_NATIVE" = 1 ]; then
      "$NATIVE_SH" bin
      # seed-devnet.sh always runs a publish step. In native mode, publishing
      # must go through hydra-native.sh's host<->Docker socket bridge instead,
      # so no-op the upstream publish here and publish bridge-aware below.
      ( cd "$DEMO" && ./seed-devnet.sh "" /usr/bin/true ) \
        || { c_red "  devnet seed failed"; exit 1; }
    else
      ( cd "$DEMO" && ./seed-devnet.sh ) \
        || { c_red "  devnet seed failed"; exit 1; }
    fi
    # Align the head's Plutus cost models with the V2 mesh line (.102 / preprod)
    # BEFORE the hydra nodes read protocol-parameters.json at startup. The demo's
    # cardano-node emits an older 251-param PlutusV3 model; mesh produces a
    # 297-param script-data-hash → PPViewHashesDontMatch on every script-spend.
    if [ "${USE_HYDRA_PARAMS:-0}" = 1 ]; then
      # Test: use Hydra's OWN reference protocol-parameters (the file hydra's test
      # suite runs Plutus on L2 with), zeroing L2 fees, instead of the cardano-cli
      # one. Isolates whether the head's empty L2 cost models are a params-file issue.
      HCP="${HCP:-$(cd "$REPO/../hydra/hydra-cluster/config" 2>/dev/null && pwd)/protocol-parameters.json}"
      if [ -f "$HCP" ]; then
        jq '.txFeeFixed = 0 | .txFeePerByte = 0 | .executionUnitPrices.priceMemory = 0 | .executionUnitPrices.priceSteps = 0 | .utxoCostPerByte = 0' \
          "$HCP" > "$DEMO/devnet/protocol-parameters.json" \
          && c_grn "  using hydra-cluster reference params (fees zeroed)" || c_red "  failed to apply hydra-cluster params"
      else
        c_red "  hydra-cluster params not found at $HCP"
      fi
    elif [ "${SKIP_ALIGN:-0}" = 1 ]; then
      c_blu "  SKIP_ALIGN=1 → leaving native devnet cost models (251-param V3)"
    else
      node "$REPO/hydra-l2-flow/align-cost-models.cjs" "$DEMO/devnet/protocol-parameters.json" "$REPO" \
        && c_grn "  cost models aligned to mesh beta.102" \
        || { c_red "  cost-model alignment FAILED (script-spend txs may PPViewHashesDontMatch)"; exit 1; }
    fi
    if [ "$HYDRA_NATIVE" = 1 ]; then
      # Apple Silicon: publish scripts + run the 3 hydra-nodes natively (no Rosetta).
      # hydra-native.sh waits for all 3 node APIs before returning.
      grep -qE '^HYDRA_SCRIPTS_TX_ID=[0-9a-f]+' "$DEMO/.env" 2>/dev/null || "$NATIVE_SH" publish
      HYDRA_KEEPALIVE=0 FRESH="${FRESH:-1}" "$NATIVE_SH" up
    else
      local txid; txid="$(docker run --rm -v "$DEMO/devnet:/devnet" "$HYDRA_IMAGE" -- \
        publish-scripts --testnet-magic 42 --node-socket /devnet/node.socket \
        --cardano-signing-key /devnet/credentials/faucet.sk 2>/dev/null | tail -1)"
      printf 'HYDRA_SCRIPTS_TX_ID=%s\n' "$txid" > "$DEMO/.env"
      ( cd "$DEMO" && docker compose up -d hydra-node-1 hydra-node-2 hydra-node-3 )
      sleep 8
    fi
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

  # Shrink the contract cooldown for the demo. submit-result / request-refund set
  # the seller/buyer cooldown to (now + cooldownTime + 10min); the 10-min term is
  # a hardcoded blocktime buffer (the hard floor), so the demo's collection /
  # authorize-withdrawal waits can't go below ~11 min. Lowering cooldownTime from
  # the seeded 7 min to 1 min keeps those waits near that floor instead of ~17 min.
  # Throwaway test DB only — does not touch the dev DB on 5432.
  docker exec "$DB_CONTAINER" psql -U postgres -d masumi_hydra_test \
    -c 'UPDATE "PaymentSource" SET "cooldownTime"=60000;' >/dev/null 2>&1 \
    && c_grn "  cooldownTime set to 60s (cooldown floor ≈ 11 min)"

  # The V2 script address bakes in cooldownPeriod, so lowering cooldownTime above
  # makes the seeded (vault A, 420000ms) address diverge from what the spend
  # services re-derive (vault B, 60000ms). Re-point the PaymentSource at vault B
  # so lock + spend + the on-chain script agree (else: "contract UTXO not found").
  RUN_TIMEOUT=40 run_tsx hydra-l2-flow/point-vault.mts

  c_blu "[3/5] Open head + commit 100 ADA (deposit finalizes in ~2 min)…"
  RUN_TIMEOUT=150 run_tsx hydra-l2-flow/00-open-head.mts
  c_blu "      waiting for the in-head deposit to incorporate…"
  for i in $(seq 1 24); do
    local n; n=$(curl -s "$NODE1/snapshot/utxo" | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>console.log(Object.keys(JSON.parse(d)).length))" 2>/dev/null)
    [ "${n:-0}" -ge 1 ] && { c_grn "  funds in head ($n UTxO)"; break; }
    sleep 10
  done
  docker exec "$DB_CONTAINER" psql -U postgres -d masumi_hydra_test \
    -c 'UPDATE "HydraHead" SET status='"'"'Open'"'"', "isEnabled"=true, "headIdentifier"='"'"'33f8e10a2a5e1f6e2276cf279eb4bc2f4a9e7442de5b7fb943a4ff67'"'"', "openedAt"=NOW();' >/dev/null 2>&1 \
    && c_grn "  HydraHead marked Open in test DB"

  c_blu "[4/5] Derive buyer address + fund buyer (40 ADA in head)…"
  local wout; wout="$(mktemp)"
  RUN_TIMEOUT=40 "$TSX" hydra-l2-flow/01-wallet.mts >"$wout" 2>&1 &
  local wp=$!; for i in $(seq 1 40); do kill -0 $wp 2>/dev/null || break; sleep 1; done; kill $wp 2>/dev/null
  BUYER="$(grep -oE 'addr_test1[qpvz][a-z0-9]+' "$wout" | head -1)"; rm -f "$wout"
  [ -n "$BUYER" ] || { c_red "  could not derive buyer address"; exit 1; }
  echo "  buyer = ${BUYER:0:24}…"
  RUN_TIMEOUT=90 run_tsx "hydra-l2-flow/02-fund-in-head.mts" "$BUYER" 40000000

  c_blu "[5/5] Give the seller a base address + fund seller (20 ADA in head)…"
  RUN_TIMEOUT=40 run_tsx hydra-l2-flow/04-fix-seller.mts
  SELLER="$(node -e "console.log(require('$REPO/hydra-l2-flow/.seller.json').address)")"
  echo "  seller = ${SELLER:0:24}…"
  RUN_TIMEOUT=90 run_tsx "hydra-l2-flow/02-fund-in-head.mts" "$SELLER" 20000000

  # Guard: the seller MUST hold an in-head UTxO or flow1/flow3 (seller-side
  # submit-result) will silently defer. Fail loudly here instead.
  local sutxo; sutxo=$(curl -s "$NODE1/snapshot/utxo" | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{const u=JSON.parse(d);let n=0;for(const k of Object.keys(u))if(u[k].address==='$SELLER')n++;console.log(n);})" 2>/dev/null)
  if [ "${sutxo:-0}" -lt 1 ]; then
    c_red "  seller has NO in-head UTxO — funding failed (not enough left in the committed 100 ADA?)."
    c_red "  flow1/flow3 will defer. Lower the buyer amount or raise the head commit, then re-run."
    exit 1
  fi
  c_grn "  seller funded ($sutxo in-head UTxO)"

  c_grn "=== UP: head open + funded, test DB seeded. Run: $0 flow1|flow2|flow3 ==="
  if [ "${RUN_KEEPALIVE:-0}" = 1 ]; then
    c_grn "  keeping native Hydra APIs alive; press Ctrl-C to stop"
    while kill -0 "$(cat "$NATIVE_STATE/node1.pid")" "$(cat "$NATIVE_STATE/node2.pid")" "$(cat "$NATIVE_STATE/node3.pid")" 2>/dev/null; do
      sleep 5
    done
    c_red "  a native hydra-node exited — see $NATIVE_STATE/node*.log"
    exit 1
  fi
}

# Top buyer/seller back up from alice's remaining in-head balance.
cmd_fund(){
  local wout; wout="$(mktemp)"
  RUN_TIMEOUT=40 "$TSX" hydra-l2-flow/01-wallet.mts >"$wout" 2>&1 &
  local wp=$!; for i in $(seq 1 40); do kill -0 $wp 2>/dev/null || break; sleep 1; done; kill $wp 2>/dev/null
  BUYER="$(grep -oE 'addr_test1q[a-z0-9]+' "$wout" | head -1)"; rm -f "$wout"
  SELLER="$(node -e "console.log(require('$REPO/hydra-l2-flow/.seller.json').address)" 2>/dev/null)"
  c_blu "topping up buyer…"; RUN_TIMEOUT=90 run_tsx "hydra-l2-flow/02-fund-in-head.mts" "$BUYER" "${1:-10000000}"
  [ -n "$SELLER" ] && { c_blu "topping up seller…"; RUN_TIMEOUT=90 run_tsx "hydra-l2-flow/02-fund-in-head.mts" "$SELLER" "${2:-5000000}"; }
}

# Preprod: hydra 2.2.0's Blockfrost follower loses ~17s/min (its poll loop sleeps
# one block-time then applies ONE block) and once drift exceeds --unsynced-period
# (600s) the node rejects ALL client inputs (RejectedInputBecauseUnsynced) — with
# no way to recover except a restart, which re-runs the startup catch-up burst.
# Guard each step: when drift crosses DRIFT_GUARD (default 400s), restart the
# nodes and wait for them to catch back up before proceeding.
drift_guard(){
  [ "$NETWORK" = preprod ] || return 0
  local limit="${DRIFT_GUARD:-400}"
  local d; d="$(NETWORK=preprod "$NATIVE_SH" drift 1 2>/dev/null)"
  case "$d" in (*[!0-9]*|'') d=999999 ;; esac
  [ "$d" -lt "$limit" ] && return 0
  c_blu "   drift ${d}s ≥ ${limit}s — restarting hydra-nodes to trigger catch-up burst…"
  NETWORK=preprod "$NATIVE_SH" restart
  NETWORK=preprod "$NATIVE_SH" wait-sync || c_red "   wait-sync timed out — proceeding anyway"
  unlock
}

# Wait until the head's observed chain time (latest Tick) passes the given epoch
# seconds. Validity-bounded steps (collection, authorize-withdrawal) carry
# invalidBefore ≈ the contract cooldown expiry (≈ when the countdown ended); the
# drift-lagged head must tick past it or the tx is OutsideValidityIntervalUTxO.
# Default cap 3600s: with restarts disabled the head clock advances at ~1/3
# real-time (drift grows ~40s/min), so covering an 800s gap takes ~2400s of
# wall time — the old 600s cap guaranteed failure once drift passed it
# (2026-07-08: 803s drift → authorize-withdrawal rejected twice).
wait_chain_past(){
  [ "$NETWORK" = preprod ] || return 0
  local target="$1" timeout="${2:-3600}" waited=0
  c_blu "   waiting for head clock to pass $(date -u -r "$target" +%H:%M:%SZ 2>/dev/null || echo "$target")…"
  while :; do
    local t es
    t="$(grep -a '"tag":"Tick"' "$NATIVE_LOG" 2>/dev/null | tail -1 | grep -oE '"chainTime":"[^"]+"' | cut -d'"' -f4)"
    t="${t%Z}"; t="${t%%.*}"
    es="$(date -j -u -f '%Y-%m-%dT%H:%M:%S' "$t" +%s 2>/dev/null || echo 0)"
    if [ "${es:-0}" -ge "$target" ]; then c_grn "   head clock past target (chainTime ${t}Z)"; return 0; fi
    if [ "$waited" -ge "$timeout" ]; then
      c_red "   head clock still behind target after ${timeout}s — proceeding (step retry may recover)"
      return 1
    fi
    sleep 10; waited=$((waited+10))
  done
}

step(){ # step <label> <script> [extra env already exported]
  unlock; drift_guard; slotenv
  c_blu "── $1 (slot $HYDRA_L2_CURRENT_SLOT)"
  local before hash attempt stepstart
  stepstart="$(date +%s)"
  for attempt in 1 2; do
    before="$(nlog_len)"   # mark the log so verdict sees ONLY this step
    run_tsx "$2"
    hash="$(head_tx_since "$before")"
    [ -n "$hash" ] && break
    # Timing edge: the tx validity window (invalidBefore forced past the
    # contract cooldown) is ahead of the drift-lagged head clock →
    # OutsideValidityIntervalUTxO. A fixed 90s retry only works while drift is
    # small (the head advances ~1/3 real-time without restarts), so wait until
    # the head clock actually passes the step start (> cooldown expiry, since
    # the countdown ended before this step began), then rebuild.
    if [ "$attempt" = 1 ] && verdict_since "$before" | grep -q OutsideValidityIntervalUTxO; then
      c_blu "   OutsideValidityIntervalUTxO — head clock behind tx window; waiting for head to catch up…"
      wait_chain_past "$stepstart" 3600 || c_red "   head still behind after 3600s — retrying anyway"
      unlock; slotenv
      c_blu "── $1 retry (slot $HYDRA_L2_CURRENT_SLOT)"
      continue
    fi
    break
  done
  local db; db="$(latest_l2_hash)"
  local match=nomatch; [ -n "$hash" ] && [ "$hash" = "$db" ] && match=match
  if [ -n "$hash" ]; then
    if [ "$match" = match ]; then
      c_grn "   head verdict: TxValid ${hash:0:16}…  (head id == Masumi DB hash ✓ — built by Masumi V2)"
    else
      c_grn "   head verdict: TxValid ${hash:0:16}…  (head accepted; Masumi DB hash=${db:0:16}…)"
    fi
  else
    c_red "   head verdict: $(verdict_since "$before")"
  fi
  # Append the per-op evidence row (rendered later by the `evidence` subcommand).
  mkdir -p "$(dirname "$EVIDENCE_TSV")"
  printf '%s\t%s\t%s\t%s\t%s\t%s\n' \
    "$1" "${hash:-NONE}" "${db:-NONE}" "$match" "${HYDRA_L2_CURRENT_SLOT:-?}" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    >> "$EVIDENCE_TSV"
}

# ── flow1 : happy path (seller paid) ─────────────────────────────────────────
cmd_flow1(){
  # past unlock so collection is reachable; future submit window.
  export LOCK_LOVELACE=10000000 SUBMIT_RESULT_OFFSET_MS=360000 UNLOCK_OFFSET_MS=-1200000 \
         DISPUTE_OFFSET_MS=1800000 PAYBY_OFFSET_MS=120000
  step "lock"           hydra-l2-flow/03-lock.mts
  step "submit-result"  hydra-l2-flow/06-submit-result.mts
  # Restart for drift at cooldown START (node has the full wait to re-sync and
  # settle), never right before the validity-bounded step — that ordering is
  # what produced the 2026-07-06 authorize-withdrawal OutsideValidityIntervalUTxO.
  DRIFT_GUARD="${DRIFT_GUARD:-250}" drift_guard
  c_blu "── collection waits the contract seller-cooldown (~13 min)…"
  countdown 780 "seller-cooldown"
  wait_chain_past "$(date +%s)" 3600
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
  # Drift restart at cooldown START — see cmd_flow1 for rationale.
  DRIFT_GUARD="${DRIFT_GUARD:-250}" drift_guard
  c_blu "── authorize-withdrawal waits the contract buyer-cooldown (~13 min)…"
  countdown 780 "buyer-cooldown"
  wait_chain_past "$(date +%s)" 3600
  step "authorize-withdrawal" hydra-l2-flow/11-authorize-withdrawal.mts
  c_grn "=== FLOW3 done (lock → submit → request(→Disputed) → authorize-withdrawal) ==="
}

# ── all : full lifecycle (fast refund path first, then the two cooldown flows) ─
cmd_all(){
  cmd_up
  cmd_evidence_reset   # clean ledger so this run's EVIDENCE.md is coherent
  c_blu "═══ FLOW 2 (refund path, no waits) ═══"; cmd_flow2
  cmd_fund
  c_blu "═══ FLOW 1 (happy path, ~13 min cooldown) ═══"; cmd_flow1
  cmd_fund
  c_blu "═══ FLOW 3 (dispute path, ~16 min cooldown) ═══"; cmd_flow3
  c_blu "═══ SETTLEMENT (Close → Fanout, back to L1) ═══"; cmd_settle
  c_grn "=== ALL FLOWS DONE — run '$0 verify' for the final head state ==="
}

# ── demo : full lifecycle with LIVE logs + banners (for showing the 7 ops) ────
# Same coverage as `all` (lock, submit-result, collection, request-refund,
# authorize-refund, collect-refund, authorize-withdrawal) but streams every
# step's full output and verifies the live head after each flow. ~30 min incl.
# the two contract cooldowns.
cmd_demo(){
  export VERBOSE=1
  : > /tmp/hydra-e2e.log
  banner "STEP 0 — Docker + hydra-node image + throwaway storage DB + open & fund a head"
  cmd_up
  cmd_evidence_reset   # clean ledger so this run's EVIDENCE.md is coherent

  banner "FLOW 2 — refund path (no cooldown): lock → request-refund → authorize-refund → collect-refund"
  cmd_flow2
  cmd_verify
  cmd_fund

  banner "FLOW 1 — happy path (~13 min cooldown): lock → submit-result → collection (seller paid)"
  cmd_flow1
  cmd_verify
  cmd_fund

  banner "FLOW 3 — dispute path (~16 min cooldown): lock → submit-result → request-refund(→Disputed) → authorize-withdrawal"
  cmd_flow3
  cmd_verify

  banner "SETTLEMENT — Close → Fanout: settle the in-head balances back to Cardano L1"
  cmd_settle

  banner "DEMO COMPLETE — all 7 escrow operations + L1 settlement exercised against the live head"
  c_grn "Full transcript saved to /tmp/hydra-e2e.log"
}

# ── verify : ground-truth head state ─────────────────────────────────────────
cmd_verify(){
  c_blu "Last head verdict:"; echo "  $(verdict)"
  c_blu "In-head escrow (script) UTxOs:"
  curl -s "$NODE1/snapshot/utxo" | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{const u=JSON.parse(d);let any=false;
    for(const k of Object.keys(u)){const x=u[k]; if(x.address.startsWith('addr_test1wq')){any=true;console.log('  '+k.slice(0,18)+'… '+x.value.lovelace+' lovelace  datum:'+(x.inlineDatum?'yes':'no'));}}
    if(!any)console.log('  (none — funds collected/refunded out)');})"
  c_blu "Recent head TxValid count:"; echo "  $(node1_logs | grep -c '"tag":"TxValid"')"
}

# ── down ─────────────────────────────────────────────────────────────────────
# ── evidence : render the per-op proof report for developers ─────────────────
cmd_evidence(){
  [ -s "$EVIDENCE_TSV" ] || { c_red "no evidence captured yet — run flow1/flow2/flow3 first"; exit 1; }
  local out="${OUT_MD:-$REPO/hydra-l2-flow/evidence/EVIDENCE.md}"
  EVIDENCE_TSV="$EVIDENCE_TSV" NATIVE_LOG="$NATIVE_LOG" DB_CONTAINER="$DB_CONTAINER" \
    NODE1="$NODE1" OUT_MD="$out" SETTLEMENT_STATE="$SETTLEMENT_STATE" node "$REPO/hydra-l2-flow/build-evidence.cjs"
  c_grn "  open: $out"
}

# Reset the evidence ledger + settlement state (call before a clean capture run).
cmd_evidence_reset(){ rm -f "$EVIDENCE_TSV" "$SETTLEMENT_STATE"; c_grn "evidence ledger cleared"; }

# ── settle : Close → Fanout the head, settling in-head UTxOs back to L1 ───────
# Runs LAST (Close is terminal — the head cannot be reused afterwards). Writes
# settlement state, then regenerates the combined EVIDENCE.md (escrow proof +
# settlement in one file).
# True L2 capacity of the CURRENT head = L1 headLovelace − storedHeadAdaOverhead.
# headLovelace is read from the live L1 UTxO holding this head's state token
# (policy = headId, asset name "HydraHeadV2" = 4879647261486561645632) via
# Blockfrost. The overhead is fixed at Init (worstCaseMinLovelace; 2,517,040 for
# our 2-party preprod heads — override via HEAD_ADA_OVERHEAD if params change).
settle_target_lovelace(){
  [ "$NETWORK" = preprod ] || return 0
  local KEY; KEY="$(cat "$REPO/hydra-l2-flow/preprod/blockfrost.txt")"
  local headid; headid="$(node1_logs | grep -ao '"headId":"[a-f0-9]*"' | tail -1 | cut -d'"' -f4)"
  [ -n "$headid" ] || return 0
  local unit="${headid}4879647261486561645632"
  local addr; addr="$(curl -s "https://cardano-preprod.blockfrost.io/api/v0/assets/$unit/addresses" -H "project_id: $KEY" \
    | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{try{console.log(JSON.parse(d)[0].address)}catch{}})")"
  [ -n "$addr" ] || return 0
  local lovelace; lovelace="$(curl -s "https://cardano-preprod.blockfrost.io/api/v0/addresses/$addr/utxos/$unit" -H "project_id: $KEY" \
    | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{try{const u=JSON.parse(d)[0];console.log(u.amount.find(a=>a.unit==='lovelace').quantity)}catch{}})")"
  [ -n "$lovelace" ] || return 0
  echo $(( lovelace - ${HEAD_ADA_OVERHEAD:-2517040} ))
}

# Neutralize the hydra 2.2.0 deposit re-apply phantom before Close: every node
# restart re-applies the head's deposit into the L2 ledger (upstream idempotency
# bug, unfixed on master as of 2026-07-06), so by settle time
# L2_total > headLovelace − storedOverhead and Close fails H65
# (ChangedHeadAdaOverhead). In-head tx fees destroy L2 value, so burning exactly
# the surplus as an L2 fee restores consistency. Proven on-chain 2026-07-02
# (close 94f7d95f…). No-op when there is no phantom (e.g. restart-free runs).
settle_burn_phantom(){
  [ "$NETWORK" = preprod ] || return 0
  local target="${HEAD_TARGET_LOVELACE:-$(settle_target_lovelace)}"
  if [ -z "$target" ]; then
    c_red "   cannot determine L1 head capacity (set HEAD_TARGET_LOVELACE) — skipping burn; Close may fail H65"
    return 0
  fi
  c_blu "   checking/burning deposit re-apply phantom (target L2 total: $target)…"
  TARGET_L2_TOTAL="$target" HYDRA_FLOW_NETWORK=preprod \
    pnpm exec tsx hydra-l2-flow/14-burn-phantom.mts 2>&1 | tee -a /tmp/hydra-e2e.log
  local rc="${PIPESTATUS[0]}"
  [ "$rc" = 0 ] || { c_red "   phantom burn FAILED (rc=$rc) — aborting settle, head stays Open"; exit 1; }
}

cmd_settle(){
  c_blu "── settle (Close → Fanout): settling in-head balances back to L1"
  local settle_timeout fanout_wait_ms
  if [ "$NETWORK" = preprod ] && [ "${SETTLE_SKIP_RESTART:-0}" = 1 ]; then
    # Caller has just brought the nodes up fresh at the tip (e.g. via
    # START_CHAIN_FROM) — an extra restart here would only re-walk backlog.
    c_blu "   SETTLE_SKIP_RESTART=1 → using already-fresh nodes"
    # Overridable: with a lagging follower the node observes the Close block
    # ~drift seconds late, pushing ReadyToFanout past the default budget.
    # settle_timeout must cover BOTH budgets (ReadyToFanout wait + the fanout
    # retry loop each get up to FANOUT_WAIT_MS) plus Close posting.
    fanout_wait_ms="${FANOUT_WAIT_MS:-900000}"
    settle_timeout="${SETTLE_TIMEOUT:-2000}"
  elif [ "$NETWORK" = preprod ]; then
    # The 2.2.0 Blockfrost poll loop loses ~17s/min and only the STARTUP
    # catch-up burst can close the gap (see BLOCKFROST-PLAN.md). By settle time
    # a full run has accumulated 600s+ of drift, so the unsynced gate would
    # reject the Close input outright. Restart both nodes (persistence keeps
    # the head Open), let them burst back to the tip, and only then Close —
    # drift starts at ~0 and stays far below every limit (600s unsynced gate,
    # 200s maxGraceTime at post-time) for the whole Close → Fanout sequence.
    c_blu "   restarting hydra-nodes to reset Blockfrost drift (catch-up burst)…"
    NETWORK=preprod "$NATIVE_SH" restart || { c_red "   node restart failed"; exit 1; }
    NETWORK=preprod "$NATIVE_SH" wait-sync \
      || { c_red "   nodes never reached sync — Close would be rejected, aborting"; exit 1; }
    # Close observation + 220s contestation period + fanout posting, all while
    # drift regrows at ~17s/min from ~0. settle_timeout covers both
    # FANOUT_WAIT_MS budgets (ReadyToFanout wait + fanout retry loop) + Close.
    fanout_wait_ms=600000
    settle_timeout=1400
  else
    fanout_wait_ms=30000
    settle_timeout=150
  fi
  # Burn the deposit re-apply phantom AFTER the (possible) restart and BEFORE
  # Close — no restart may happen in between, or the phantom regrows.
  settle_burn_phantom
  NATIVE_LOG="$NATIVE_LOG" NODE1="$NODE1" SETTLEMENT_STATE="$SETTLEMENT_STATE" \
    FANOUT_WAIT_MS="$fanout_wait_ms" \
    RUN_TIMEOUT="$settle_timeout" run_tsx hydra-l2-flow/13-settle.mts
  # Fold the settlement into the combined evidence report (best-effort).
  [ -s "$EVIDENCE_TSV" ] && cmd_evidence || true
}

cmd_down(){
  [ "$HYDRA_NATIVE" = 1 ] && NETWORK="$NETWORK" "$NATIVE_SH" down 2>/dev/null
  [ "$NETWORK" != preprod ] && ( cd "$DEMO" && docker compose down )
  docker rm -f "$DB_CONTAINER" >/dev/null 2>&1
  c_grn "=== stopped, test DB removed (dev DB on 5432 untouched) ==="
}

case "${1:-}" in
  up)     preflight "$@"; cmd_up ;;
  demo)   preflight "$@"; cmd_demo ;;
  all)    preflight "$@"; cmd_all ;;
  flow1)  preflight "$@"; cmd_flow1 ;;
  flow2)  preflight "$@"; cmd_flow2 ;;
  flow3)  preflight "$@"; cmd_flow3 ;;
  fund)   preflight "$@"; cmd_fund "${2:-}" "${3:-}" ;;
  op)     preflight "$@"; step "${2:?usage: op <label> <script>}" "${3:?usage: op <label> <script>}" ;;
  verify) cmd_verify ;;
  settle) preflight "$@"; cmd_settle ;;
  evidence)       cmd_evidence ;;
  evidence-reset) cmd_evidence_reset ;;
  down)   cmd_down ;;
  *) grep -E '^#( |$)' "$0" | sed -n '2,29p' | sed 's/^# \{0,1\}//'; exit 1 ;;
esac
