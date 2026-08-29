#!/usr/bin/env bash
#
# replicate-benchmark.sh — reproduce the Masumi Hydra L2 benchmark end to end,
# on Cardano preprod, from a clean state.
#
# Produces the same three measurements reported to the team:
#   1. raw agent-to-agent L2 throughput + latency (durable SSD persistence)
#   2. the same, with persistence on a RAM disk (isolates disk cost)
#   3. full Masumi escrow lifecycles (lock -> submit-result -> collect) driven
#      by masumi's OWN services, with the Plutus validator running in-head
#   4. a timestamped timeline straight from hydra-node's event store
#
# Everything lands in hydra-l2-flow/evidence/.
#
# Usage:
#   ./hydra-l2-flow/replicate-benchmark.sh all        # everything (~50 min)
#   ./hydra-l2-flow/replicate-benchmark.sh head       # just open a fresh head
#   ./hydra-l2-flow/replicate-benchmark.sh raw        # raw L2 bench (SSD)
#   ./hydra-l2-flow/replicate-benchmark.sh raw-ram    # raw L2 bench (RAM disk)
#   ./hydra-l2-flow/replicate-benchmark.sh escrow     # escrow e2e bench
#   ./hydra-l2-flow/replicate-benchmark.sh timeline   # extract head timeline
#
# PREREQUISITES
#   - macOS/arm64 or Linux; Docker running (for the test Postgres)
#   - hydra-l2-flow/preprod/ holds the party keys + blockfrost.txt
#   - the purchasing wallet has >= ~250 tADA on preprod
#   - .env has ENCRYPTION_KEY (do NOT export a shell-extracted copy; dotenv
#     loads it, and a mangled value silently breaks API-key hashing)
#
# WHAT GETS CONSUMED
#   Opening a head commits COMMIT_ADA (default 110) into the head. Until the
#   fanout execution-budget issue is resolved, collect all escrows BEFORE
#   closing or that ADA stays in the head (safe, but not on L1).
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO" || exit 1

NETWORK=preprod
export NETWORK HYDRA_FLOW_NETWORK="$NETWORK"
NODE1="${NODE1:-http://127.0.0.1:4001}"
PREPROD_DIR="$REPO/hydra-l2-flow/preprod"
DB_CONTAINER="${DB_CONTAINER:-masumi-hydra-test-db}"
DB_PORT="${DB_PORT:-5434}"          # 5433 often taken by another project
export DATABASE_URL="postgresql://postgres:testpass@localhost:${DB_PORT}/masumi_hydra_test?schema=public"
COMMIT_ADA="${COMMIT_ADA:-110}"
CHAINS="${CHAINS:-40}"
HOPS="${HOPS:-250}"
WINDOW="${WINDOW:-500}"
# 10 escrows need 10*4+10 = 50 ADA for the buyer plus 20 for the seller, which
# fits inside the default 110 ADA commit and still leaves the node change to
# work with. Raise COMMIT_ADA alongside ESCROWS if you want a bigger batch.
ESCROWS="${ESCROWS:-10}"
KEYS="--sk1 $PREPROD_DIR/purchasing-cardano.sk --sk2 $PREPROD_DIR/selling-cardano.sk"
RAMDISK=/Volumes/HydraRam

blue(){ printf '\033[36m%s\033[0m\n' "$*"; }
green(){ printf '\033[32m%s\033[0m\n' "$*"; }
red(){ printf '\033[31m%s\033[0m\n' "$*"; }

bf_key(){ cat "$PREPROD_DIR/blockfrost.txt"; }

head_status(){ curl -s --max-time 8 "$NODE1/head" | jq -r .tag 2>/dev/null; }
head_ada(){ curl -s --max-time 8 "$NODE1/snapshot/utxo" | jq '[to_entries[].value.value.lovelace]|add/1000000' 2>/dev/null; }

# ── test database ────────────────────────────────────────────────────────────
cmd_db(){
  blue "[db] test Postgres on :$DB_PORT"
  if docker ps -a --format '{{.Names}}' | grep -q "^${DB_CONTAINER}$"; then
    docker start "$DB_CONTAINER" >/dev/null 2>&1
  else
    docker run -d --name "$DB_CONTAINER" -e POSTGRES_PASSWORD=testpass \
      -e POSTGRES_DB=masumi_hydra_test -p "${DB_PORT}:5432" postgres:15 >/dev/null
  fi
  for _ in $(seq 1 30); do docker exec "$DB_CONTAINER" pg_isready -U postgres >/dev/null 2>&1 && break; sleep 1; done
  npx prisma migrate deploy --config prisma/prisma.config.ts >/dev/null 2>&1
  npx prisma db seed --config prisma/prisma.config.ts >/dev/null 2>&1
  # 60s cooldown shortens the contractual wait before collection is legal.
  docker exec "$DB_CONTAINER" psql -U postgres -d masumi_hydra_test \
    -c 'UPDATE "PaymentSource" SET "cooldownTime"=60000;' >/dev/null 2>&1
  pnpm exec tsx hydra-l2-flow/point-vault.mts >/dev/null 2>&1
  pnpm exec tsx hydra-l2-flow/seed-head-row.mts >/dev/null 2>&1
  green "  db ready"
}

# ── fresh head ───────────────────────────────────────────────────────────────
cmd_head(){
  blue "[head] opening a fresh preprod head (${COMMIT_ADA} ADA commit)"

  # 00-open-head commits the SMALLEST UTxO >= 100 ADA and needs a strictly
  # LARGER one left as node fuel. Split first or it fails.
  pnpm exec tsx hydra-l2-flow/split-l1-ada.mts "$COMMIT_ADA" 2>&1 | tail -2
  # Wait for the split to actually appear on chain. 00-open-head needs BOTH a
  # UTxO >= 100 ADA and a strictly larger one; if we proceed too early it picks
  # the wrong input and aborts with "need a bigger fuel UTxO".
  blue "  waiting for the split to confirm on L1…"
  local purch_addr split_ok=0
  purch_addr="$(pnpm exec tsx hydra-l2-flow/check-preprod-balances.mts 2>/dev/null | grep -oE 'addr_test1v[a-z0-9]+' | head -1)"
  for _ in $(seq 1 30); do
    if curl -s -H "project_id: $(bf_key)" \
        "https://cardano-preprod.blockfrost.io/api/v0/addresses/${purch_addr}/utxos" 2>/dev/null \
        | jq -e --argjson want "$COMMIT_ADA" \
          '[.[] | (.amount[] | select(.unit=="lovelace") | .quantity | tonumber)] | any(. == ($want*1000000))' >/dev/null 2>&1; then
      split_ok=1; green "  split confirmed (${COMMIT_ADA} ADA commit candidate present)"; break
    fi
    sleep 10
  done
  [ "$split_ok" = 1 ] || { red "  split never confirmed — aborting before it wastes a head"; return 1; }

  NETWORK=preprod ./hydra-l2-flow/hydra-native.sh down >/dev/null 2>&1
  [ -d "$PREPROD_DIR/persistence" ] && mv "$PREPROD_DIR/persistence" "$PREPROD_DIR/persistence-archived-$(date +%Y%m%d-%H%M%S)"

  # Anchor at the tip: without this a fresh node replays days of chain.
  local tip
  tip="$(curl -s -H "project_id: $(bf_key)" https://cardano-preprod.blockfrost.io/api/v0/blocks/latest | jq -r '"\(.slot).\(.hash)"')"
  blue "  START_CHAIN_FROM=$tip"
  START_CHAIN_FROM="$tip" NETWORK=preprod ./hydra-l2-flow/hydra-native.sh up 2>&1 | tail -1
  NETWORK=preprod ./hydra-l2-flow/hydra-native.sh wait-sync 2>&1 | tail -1

  HYDRA_FLOW_NETWORK=preprod pnpm exec tsx hydra-l2-flow/00-open-head.mts 2>&1 | tail -2
  blue "  waiting for the commit deposit to incorporate (~4 min on preprod)…"
  for i in $(seq 1 60); do
    local n; n="$(curl -s --max-time 8 "$NODE1/snapshot/utxo" | jq 'length' 2>/dev/null)"
    if [ "${n:-0}" -ge 1 ]; then
      green "  head funded: $(head_ada) ADA"
      # Re-pin the DB row to THIS head. seed-head-row reuses an existing row, so
      # after opening a new head the row still carries the PREVIOUS head id and
      # the connection manager rejects every frame with
      #   "Hydra frame head id did not match the pinned head",
      # which breaks the escrow bench before it starts.
      pnpm exec tsx hydra-l2-flow/sync-head-row.mts "$NODE1" 2>&1 | sed 's/^/  /' \
        || { red "  could not pin the DB row to the live head"; return 1; }
      settle_head; return $?
    fi
    sleep 10
  done
  red "  deposit did not incorporate"; return 1
}

# For roughly 90s after a deposit incorporates, the head still rejects L2 txs
# with ConwayMempoolFailure "All inputs are spent" (the increment is not fully
# settled node-side). Probe with a tiny throwaway bench until one succeeds, so
# the real measurements never start inside that window.
settle_head(){
  blue "  waiting out the post-deposit settling window…"
  local i
  for i in $(seq 1 12); do
    if pnpm exec tsx hydra-l2-flow/bench-l2-tps.mts --mode saturation --chains 2 --hops 2 $KEYS 2>&1 \
         | grep -q "TPS confirmed"; then
      green "  head is accepting L2 txs (settled after ~$(( i * 20 ))s)"
      pnpm exec tsx hydra-l2-flow/consolidate-head-funds.mts >/dev/null 2>&1
      return 0
    fi
    sleep 20
  done
  red "  head never started accepting L2 txs — aborting before it produces junk numbers"
  return 1
}

# ── raw L2 benchmark ─────────────────────────────────────────────────────────
run_raw(){
  local label="$1"
  # Marker file: anything older than this belongs to a PREVIOUS run and must
  # never be reported as this run's result.
  local marker; marker="$(mktemp)"
  # Retry each measurement: a head can transiently reject L2 txs (the
  # post-deposit / post-restart window), and losing a measurement to a
  # 30-second hiccup is worse than waiting for it.
  bench_with_retry(){
    local desc="$1"; shift
    local attempt
    for attempt in 1 2 3; do
      pnpm exec tsx hydra-l2-flow/consolidate-head-funds.mts >/dev/null 2>&1
      if pnpm exec tsx hydra-l2-flow/bench-l2-tps.mts "$@" $KEYS 2>&1 \
           | grep -E "TPS confirmed|fatal" | tee /dev/stderr | grep -q "TPS confirmed"; then
        return 0
      fi
      [ "$attempt" -lt 3 ] && { blue "  $desc attempt $attempt failed — retrying in 30s"; sleep 30; }
    done
    red "  $desc failed after 3 attempts"
    return 1
  }

  blue "[raw:$label] sustained ${CHAINS}x${HOPS} txs, window $WINDOW"
  bench_with_retry "sustained" --mode saturation --chains "$CHAINS" --hops "$HOPS" --window "$WINDOW"
  blue "[raw:$label] latency, 200 sequential round-trips"
  bench_with_retry "latency" --mode latency --hops 200
  # Read back the newest LATENCY-mode result specifically. Taking the newest
  # directory blindly reports a saturation run's batched latency if the latency
  # run failed — a real mis-report that happened during development.
  local d
  for d in $(ls -t hydra-l2-flow/evidence/bench/); do
    local f="hydra-l2-flow/evidence/bench/$d/result.json"
    [ -f "$f" ] || continue
    # Must be NEWER than this run's marker, or it is a leftover from a previous
    # run and reporting it would attribute an old number to this one.
    [ "$f" -nt "$marker" ] || continue
    if [ "$(jq -r .mode "$f" 2>/dev/null)" = "latency" ]; then
      jq -r '"  latency p50=\(.results.latencyMsToConfirmed.p50)ms p95=\(.results.latencyMsToConfirmed.p95)ms  (\(.results.confirmed)/\(.config.totalTxs) confirmed)"' "$f"
      rm -f "$marker"; return 0
    fi
  done
  rm -f "$marker"
  red "  no latency result from THIS run — the latency run did not complete (numbers above, if any, are from an earlier run and were suppressed)"
  return 1
}

cmd_raw(){ run_raw ssd; }

cmd_raw_ram(){
  # macOS only: uses hdiutil/diskutil. On Linux the equivalent is
  #   sudo mount -t tmpfs -o size=4G tmpfs /mnt/hydraram
  # and pointing PERSIST_SUBDIR at it — but on Linux this whole comparison is
  # largely moot, since NVMe fsync is already ~0.1-1 ms.
  if [ "$(uname -s)" != "Darwin" ]; then
    red "[raw:ram] macOS only (needs hdiutil/diskutil)."
    red "  On Linux use a tmpfs mount, or skip: the SSD number is already representative there."
    return 2
  fi
  blue "[raw:ram] moving persistence to a RAM disk (measurement only — NEVER production)"
  NETWORK=preprod ./hydra-l2-flow/hydra-native.sh down >/dev/null 2>&1; sleep 3
  local dev; dev="$(hdiutil attach -nomount ram://8388608 | awk '{print $1}')"   # 4 GB; 1 GB fills up
  diskutil erasevolume HFS+ HydraRam "$dev" >/dev/null
  cp -R "$PREPROD_DIR/persistence/purchasing" "$RAMDISK/purchasing"
  cp -R "$PREPROD_DIR/persistence/selling" "$RAMDISK/selling"
  ln -sfn "$RAMDISK" "$PREPROD_DIR/persistence-ram"
  NETWORK=preprod PERSIST_SUBDIR=persistence-ram ./hydra-l2-flow/hydra-native.sh up 2>&1 | tail -1
  NETWORK=preprod ./hydra-l2-flow/hydra-native.sh wait-sync 2>&1 | tail -1

  run_raw ram

  blue "[raw:ram] restoring persistence to durable disk"
  NETWORK=preprod PERSIST_SUBDIR=persistence-ram ./hydra-l2-flow/hydra-native.sh down >/dev/null 2>&1; sleep 3
  rm -rf "$PREPROD_DIR/persistence"; mkdir -p "$PREPROD_DIR/persistence"
  cp -R "$RAMDISK/purchasing" "$PREPROD_DIR/persistence/purchasing"
  cp -R "$RAMDISK/selling" "$PREPROD_DIR/persistence/selling"
  rm -f "$PREPROD_DIR/persistence-ram"
  diskutil unmount force "$RAMDISK" >/dev/null 2>&1; hdiutil detach "$dev" >/dev/null 2>&1
  green "  head state back on SSD"
}

# ── escrow e2e ───────────────────────────────────────────────────────────────
cmd_escrow(){
  blue "[escrow] $ESCROWS full lifecycles through masumi's own services"
  NETWORK=preprod ./hydra-l2-flow/hydra-native.sh up >/dev/null 2>&1
  NETWORK=preprod ./hydra-l2-flow/hydra-native.sh wait-sync >/dev/null 2>&1

  local buyer seller need
  buyer="$(pnpm exec tsx hydra-l2-flow/01-wallet.mts 2>/dev/null | grep -oE 'addr_test1q[a-z0-9]+' | head -1)"
  # Must scope to the V2 payment source: the seed creates Selling wallets for
  # BOTH V1 and V2, and an unscoped LIMIT 1 happily returns the V1 one — which
  # funds an address the head never sees, and the escrow bench then starves.
  seller="$(docker exec "$DB_CONTAINER" psql -U postgres -d masumi_hydra_test -t -A -c \
    "SELECT hw.\"walletAddress\" FROM \"HotWallet\" hw
       JOIN \"PaymentSource\" ps ON ps.id = hw.\"paymentSourceId\"
      WHERE hw.type='Selling' AND hw.\"deletedAt\" IS NULL
        AND ps.\"paymentSourceType\"='Web3CardanoV2' AND ps.\"deletedAt\" IS NULL
      LIMIT 1;")"
  [ -n "$seller" ] || { red "  could not resolve the V2 Selling wallet"; return 1; }
  need=$(( ESCROWS * 4 + 10 ))
  if [ $(( need + 20 )) -ge "$COMMIT_ADA" ]; then
    red "  ESCROWS=$ESCROWS needs ~$(( need + 20 )) ADA in-head but only $COMMIT_ADA was committed."
    red "  Re-run with a bigger commit (COMMIT_ADA=$(( need + 40 )) ./$(basename "$0") head) or fewer escrows."
    return 1
  fi
  # In-head funding fails transiently (the node reports "funding tx never
  # confirmed") and also whenever the source UTxOs have fragmented, which the
  # consolidate step fixes. Retry, verifying the recipient actually received it.
  fund_in_head(){
    local addr="$1" lovelace="$2" name="$3" attempt got
    for attempt in 1 2 3 4; do
      pnpm exec tsx hydra-l2-flow/consolidate-head-funds.mts >/dev/null 2>&1
      pnpm exec tsx hydra-l2-flow/02-fund-in-head.mts "$addr" "$lovelace" >/dev/null 2>&1
      got="$(curl -s --max-time 10 "$NODE1/snapshot/utxo" \
        | jq --arg a "$addr" '[to_entries[] | select(.value.address==$a and .value.inlineDatum==null) | .value.value.lovelace] | (add // 0)')"
      if [ "${got:-0}" -ge "$lovelace" ]; then
        green "  $name funded ($(( got / 1000000 )) ADA in-head)"; return 0
      fi
      blue "  $name funding attempt $attempt short (${got:-0}/$lovelace) — retrying"
      sleep 15
    done
    red "  could not fund $name in-head"; return 1
  }

  blue "  funding buyer ${need} ADA + seller 20 ADA in-head"
  fund_in_head "$buyer" $(( need * 1000000 )) buyer || return 1
  fund_in_head "$seller" 20000000 seller || return 1

  pnpm exec tsx hydra-l2-flow/bench-escrow-e2e.mts "$ESCROWS" 2>&1 | grep -E "Phase [ABC] done|RESULT|FATAL"
}

# ── timeline ─────────────────────────────────────────────────────────────────
cmd_timeline(){
  blue "[timeline] extracting head history from hydra-node's own event store"
  mkdir -p hydra-l2-flow/evidence/timeline
  pnpm exec tsx hydra-l2-flow/extract-head-timeline.mts \
    "$PREPROD_DIR/persistence/purchasing" \
    --json hydra-l2-flow/evidence/timeline/head-timeline.json \
    | tee hydra-l2-flow/evidence/timeline/head-timeline.txt
}

cmd_all(){
  # db and head must succeed — everything downstream needs a funded head.
  cmd_db || { red "db step failed"; return 1; }
  cmd_head || { red "head step failed"; return 1; }
  # The measurement steps are independent: a skip (e.g. raw-ram on Linux) or a
  # single failure must not silently swallow the ones after it.
  cmd_raw     || red "  (raw bench did not complete)"
  cmd_raw_ram || red "  (ram bench skipped or failed — continuing)"
  cmd_escrow  || red "  (escrow bench did not complete)"
  cmd_timeline
  green "=== done — evidence in hydra-l2-flow/evidence/ ==="
  red   "NOTE: the head is left OPEN with ADA inside. Collect escrows before closing:"
  red   "      fanout of a head holding many script UTxOs fails on Plutus ex-units."
}

# No default: `all` opens a head and commits real tADA, so it must be asked for
# explicitly rather than being what a bare invocation does.
case "${1:-}" in
  all)      cmd_all ;;
  db)       cmd_db ;;
  head)     cmd_head ;;
  raw)      cmd_raw ;;
  raw-ram)  cmd_raw_ram ;;
  escrow)   cmd_escrow ;;
  timeline) cmd_timeline ;;
  *) echo "usage: $0 {all|db|head|raw|raw-ram|escrow|timeline}"; exit 2 ;;
esac
