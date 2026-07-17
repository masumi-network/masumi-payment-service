#!/usr/bin/env bash
#
# hydra-native.sh — run Hydra hydra-nodes NATIVELY on Apple Silicon (pinned to
# HYDRA_VERSION, default 2.3.0).
#
# WHY: Hydra 2.2.0 added a Rust BLS accumulator (Partial Fanout). The published
# linux/amd64 docker images run under Docker Desktop's Rosetta emulation on
# arm64 Macs, where that native crypto pegs a core at 100% CPU and never makes
# progress — `publish-scripts` and even node startup hang indefinitely. The
# official **native aarch64-darwin** hydra-node binary has no such wall (node
# boots in seconds at ~5% CPU). 2.1.0 had no BLS path, which is why it worked
# emulated and 2.2.0 does not.
#
# This script runs the THREE demo hydra-nodes as native host processes, while
# cardano-node stays in Docker (it runs fine under emulation — it only forges
# blocks). The native nodes reach cardano-node's n2c unix socket — which lives
# inside the Docker VM and is NOT directly connectable from the host — via a
# small bridge: a socat sidecar exposes it over TCP, and a host-side Python
# forwarder re-presents it as a local unix socket.
#
# Layout (host):
#   node1/alice : api 127.0.0.1:4001  etcd 127.0.0.1:5001  monitoring 6001
#   node2/bob   : api 127.0.0.1:4002  etcd 127.0.0.1:5002  monitoring 6002
#   node3/carol : api 127.0.0.1:4003  etcd 127.0.0.1:5003  monitoring 6003
#
# Usage:
#   ./hydra-native.sh up        # bridge + 3 native nodes (publish-scripts first if needed)
#   ./hydra-native.sh down      # stop nodes + bridge
#   ./hydra-native.sh restart   # down + up, persistence intact (preprod: re-runs the
#                               # Blockfrost catch-up burst → drift collapses to ~0)
#   ./hydra-native.sh wait-sync # block until node drift < DRIFT_TARGET (default 60s)
#   ./hydra-native.sh drift [n] # print node n's current drift in seconds (default node 1)
#   ./hydra-native.sh status    # show node/bridge/API state
#   ./hydra-native.sh publish   # (re)publish HYDRA_VERSION reference scripts natively -> $DEMO/.env
#   ./hydra-native.sh bin       # ensure native binary is present (download if missing)
#
# Testing an unreleased fix (e.g. master, ahead of the pinned HYDRA_VERSION
# tag) without disturbing the pinned binary:
#   HYDRA_BIN_TAG=master-6e2754c \
#   HYDRA_BIN_RUN_ID=28878987397 \
#   HYDRA_BIN_ARTIFACT=hydra-aarch64-darwin-2.3.0-46-g6e2754c5a \
#     ./hydra-native.sh bin
#   # then pass the same three env vars to `up`/`restart`/etc. to run against it.
#
set -uo pipefail

REPO="${REPO:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
DEMO="${DEMO:-${HYDRA_DEMO_DIR:-$( \
  for d in "$REPO/../hydra/demo" "$REPO/../../hydra/demo"; do \
    [ -d "$d" ] && { (cd "$d" && pwd); break; }; \
  done )}}"

HYDRA_VERSION="${HYDRA_VERSION:-2.3.0}"
# Only used for the HYDRA_BIN_TAG path below (testing an unreleased commit):
# hydra-node CI publishes those as workflow artifacts, not release assets.
HYDRA_BIN_RUN_ID="${HYDRA_BIN_RUN_ID:-27418396480}"
HYDRA_BIN_ARTIFACT="${HYDRA_BIN_ARTIFACT:-hydra-aarch64-darwin-${HYDRA_VERSION}}"
# Optional channel tag (e.g. "master-6e2754c") to test an unreleased fix
# without disturbing the pinned HYDRA_VERSION binary at .bin/hydra-node. Set
# alongside HYDRA_BIN_RUN_ID/HYDRA_BIN_ARTIFACT to point at a specific CI
# artifact; the binary lands at .bin/hydra-node-<tag> and is left in place for
# reuse/rollback.
HYDRA_BIN_TAG="${HYDRA_BIN_TAG:-}"

NETWORK="${NETWORK:-devnet}"   # devnet | preprod
PREPROD_DIR="${PREPROD_DIR:-$REPO/hydra-l2-flow/preprod}"
# Which persistence/<party> tree under $PREPROD_DIR to run against — override to
# point at an archived head (e.g. a copy of persistence-closed-20260706) without
# touching the live "persistence" dir.
PERSIST_SUBDIR="${PERSIST_SUBDIR:-persistence}"

BIN_DIR="${BIN_DIR:-$REPO/hydra-l2-flow/.bin}"
if [ -n "$HYDRA_BIN_TAG" ]; then
  NATIVE_BIN="${NATIVE_BIN:-$BIN_DIR/hydra-node-${HYDRA_BIN_TAG}}"
else
  NATIVE_BIN="${NATIVE_BIN:-$BIN_DIR/hydra-node}"
fi
STATE="${STATE:-$REPO/hydra-l2-flow/.native-state}"

BRIDGE_NAME="${BRIDGE_NAME:-hydra-n2c-bridge}"
BRIDGE_PORT="${BRIDGE_PORT:-3333}"
HOST_SOCKET="${HOST_SOCKET:-$STATE/node.socket}"
CARDANO_IMAGE="${CARDANO_IMAGE:-ghcr.io/intersectmbo/cardano-node:10.6.2}"

# macOS ships libiconv only in the dyld shared cache; the nix-built binary
# hardcodes a /nix/store libiconv path, so point dyld at /usr/lib by leaf name.
export DYLD_FALLBACK_LIBRARY_PATH="${DYLD_FALLBACK_LIBRARY_PATH:-/usr/lib}"

c_grn(){ printf '\033[32m%s\033[0m\n' "$*"; }
c_red(){ printf '\033[31m%s\033[0m\n' "$*"; }
c_blu(){ printf '\033[36m%s\033[0m\n' "$*"; }

mkdir -p "$STATE" "$BIN_DIR"

# ── native binary ────────────────────────────────────────────────────────────
ensure_bin(){
  if [ -x "$NATIVE_BIN" ]; then
    repair_dylibs
    return 0
  fi
  command -v gh >/dev/null 2>&1 || { c_red "missing: gh (needed to download the native binary)"; exit 1; }
  local tmp; tmp="$(mktemp -d)"
  if [ -n "$HYDRA_BIN_TAG" ]; then
    c_blu "Downloading native $HYDRA_BIN_ARTIFACT (CI artifact, ~176 MiB)…"
    gh run download "$HYDRA_BIN_RUN_ID" --repo cardano-scaling/hydra \
      --name "$HYDRA_BIN_ARTIFACT" --dir "$tmp" || { c_red "download failed"; exit 1; }
  else
    # Tagged releases from 2.3.0 onward publish aarch64-darwin binaries as a
    # release zip (2.2.0 and earlier had no release assets at all).
    c_blu "Downloading native hydra-aarch64-darwin-${HYDRA_VERSION}.zip (release asset, ~176 MiB)…"
    gh release download "$HYDRA_VERSION" --repo cardano-scaling/hydra \
      --pattern "hydra-aarch64-darwin-${HYDRA_VERSION}.zip" --dir "$tmp" || { c_red "download failed"; exit 1; }
    (cd "$tmp" && unzip -oq "hydra-aarch64-darwin-${HYDRA_VERSION}.zip") || { c_red "unzip failed"; exit 1; }
  fi
  [ -f "$tmp/hydra-node" ] || { c_red "artifact missing hydra-node"; exit 1; }
  install -m 0755 "$tmp/hydra-node" "$NATIVE_BIN"
  [ -f "$tmp/hydra-tui" ] && install -m 0755 "$tmp/hydra-tui" "$BIN_DIR/hydra-tui"
  rm -rf "$tmp"
  repair_dylibs
  c_grn "  installed -> $NATIVE_BIN ($("$NATIVE_BIN" --version 2>/dev/null | head -1))"
}

repair_dylibs(){
  command -v otool >/dev/null 2>&1 || return 0
  command -v install_name_tool >/dev/null 2>&1 || return 0
  local nix_iconv
  nix_iconv="$(otool -L "$NATIVE_BIN" 2>/dev/null | awk '/\/nix\/store\/.*libiconv.*libiconv\.2\.dylib/ {print $1; exit}')"
  [ -n "$nix_iconv" ] || return 0
  install_name_tool -change "$nix_iconv" /usr/lib/libiconv.2.dylib "$NATIVE_BIN" || return 1
  command -v codesign >/dev/null 2>&1 && codesign --force --sign - "$NATIVE_BIN" >/dev/null 2>&1
}

# ── socket bridge (cardano-node n2c -> host unix socket) ─────────────────────
bridge_up(){
  if ! docker ps --filter "name=^${BRIDGE_NAME}$" --format '{{.Names}}' | grep -q "$BRIDGE_NAME"; then
    docker rm -f "$BRIDGE_NAME" >/dev/null 2>&1
    docker run -d --rm --name "$BRIDGE_NAME" \
      -v "$DEMO/devnet:/devnet" -p "127.0.0.1:${BRIDGE_PORT}:${BRIDGE_PORT}" \
      --entrypoint socat "$CARDANO_IMAGE" \
      "TCP-LISTEN:${BRIDGE_PORT},reuseaddr,fork" UNIX-CONNECT:/devnet/node.socket >/dev/null \
      || { c_red "bridge sidecar failed to start"; exit 1; }
  fi
  # host forwarder: $HOST_SOCKET -> tcp 127.0.0.1:$BRIDGE_PORT
  if [ ! -f "$STATE/forwarder.pid" ] || ! kill -0 "$(cat "$STATE/forwarder.pid" 2>/dev/null)" 2>/dev/null; then
    write_forwarder
    nohup python3 "$STATE/n2c-forward.py" "$HOST_SOCKET" "$BRIDGE_PORT" >"$STATE/forwarder.log" 2>&1 < /dev/null &
    echo $! > "$STATE/forwarder.pid"
    sleep 1
  fi
  [ -S "$HOST_SOCKET" ] && c_grn "  bridge up ($HOST_SOCKET -> :$BRIDGE_PORT)" || { c_red "  host socket not created"; exit 1; }
}

bridge_down(){
  if [ -f "$STATE/forwarder.pid" ]; then kill "$(cat "$STATE/forwarder.pid")" 2>/dev/null; rm -f "$STATE/forwarder.pid"; fi
  docker rm -f "$BRIDGE_NAME" >/dev/null 2>&1
  rm -f "$HOST_SOCKET"
}

write_forwarder(){
  cat > "$STATE/n2c-forward.py" <<'PY'
import os, socket, sys, threading
UNIX_PATH = sys.argv[1]
TCP_PORT = int(sys.argv[2])
def pump(src, dst):
    try:
        while True:
            data = src.recv(65536)
            if not data: break
            dst.sendall(data)
    except OSError:
        pass
    finally:
        for s in (src, dst):
            try: s.shutdown(socket.SHUT_RDWR)
            except OSError: pass
def handle(conn):
    try:
        tcp = socket.create_connection(("127.0.0.1", TCP_PORT))
    except OSError as e:
        print(f"[forward] TCP connect failed: {e}", file=sys.stderr); conn.close(); return
    threading.Thread(target=pump, args=(conn, tcp), daemon=True).start()
    threading.Thread(target=pump, args=(tcp, conn), daemon=True).start()
def main():
    if os.path.exists(UNIX_PATH): os.unlink(UNIX_PATH)
    srv = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    srv.bind(UNIX_PATH); srv.listen(16)
    print(f"[forward] listening {UNIX_PATH} -> 127.0.0.1:{TCP_PORT}", file=sys.stderr)
    while True:
        conn, _ = srv.accept(); handle(conn)
main()
PY
}

# ── reference scripts (published natively, fast) ─────────────────────────────
publish(){
  ensure_bin
  bridge_up
  c_blu "Publishing $HYDRA_VERSION reference scripts (native)…"
  local out
  out="$("$NATIVE_BIN" publish-scripts \
    --testnet-magic 42 \
    --node-socket "$HOST_SOCKET" \
    --cardano-signing-key "$DEMO/devnet/credentials/faucet.sk" 2>"$STATE/publish.err" | tail -1)"
  if [ -z "$out" ]; then c_red "  publish-scripts produced no tx id"; cat "$STATE/publish.err" >&2; exit 1; fi
  printf 'HYDRA_SCRIPTS_TX_ID=%s\n' "$out" > "$DEMO/.env"
  c_grn "  HYDRA_SCRIPTS_TX_ID=$out"
}

# ── nodes ────────────────────────────────────────────────────────────────────
# args: idx self-key  vk1 vk2  c-self c-vk1 c-vk2  persistence
start_node(){
  local idx="$1" sk="$2" vk1="$3" vk2="$4" csk="$5" cvk1="$6" cvk2="$7" persist="$8"
  local api=$((4000 + idx)) p2p=$((5000 + idx)) mon=$((6000 + idx))
  local peers=()
  for j in 1 2 3; do [ "$j" != "$idx" ] && peers+=( --peer "127.0.0.1:$((5000 + j))" ); done
  (
    cd "$DEMO" || exit 1
    nohup "$NATIVE_BIN" \
      --node-id "$idx" \
      --api-host 127.0.0.1 --api-port "$api" \
      --listen "127.0.0.1:$p2p" --monitoring-port "$mon" \
      "${peers[@]}" \
      --hydra-scripts-tx-id "$SCRIPTS_TX_ID" \
      --hydra-signing-key "$sk" \
      --hydra-verification-key "$vk1" --hydra-verification-key "$vk2" \
      --cardano-signing-key "devnet/credentials/$csk" \
      --cardano-verification-key "devnet/credentials/$cvk1" \
      --cardano-verification-key "devnet/credentials/$cvk2" \
      --ledger-protocol-parameters devnet/protocol-parameters.json \
      --testnet-magic 42 --node-socket "$HOST_SOCKET" \
      --persistence-dir "$persist" \
      --contestation-period "${CONTESTATION_PERIOD:-3s}" \
      --deposit-period "${DEPOSIT_PERIOD:-120s}" \
      >"$STATE/node$idx.log" 2>&1 < /dev/null &
    echo $! > "$STATE/node$idx.pid"
  )
}

# preprod: 2 parties, blockfrost backend, no socket/bridge/$DEMO
start_node_preprod(){
  local idx="$1" party="$2"
  local api=$((4000 + idx)) p2p=$((5000 + idx)) mon=$((6000 + idx))
  local other=$(( idx == 1 ? 2 : 1 ))
  local persist="$PREPROD_DIR/$PERSIST_SUBDIR/$party"
  mkdir -p "$persist"
  # hydra-node re-extracts its embedded etcd to bin/etcd on EVERY boot by
  # rewriting the file in place (same inode). On Apple Silicon, exec-ing a
  # rewritten Mach-O while the previous etcd process is still winding down gets
  # SIGKILLed by the kernel's code-signature cache (etcd "ExitFailure (-9)" at
  # startup, observed 2026-07-16 on a drift-guard restart). Deleting first makes
  # the extraction create a FRESH inode, which sidesteps the race entirely.
  rm -f "$persist/bin/etcd"
  local other_vk; other_vk="$([ "$idx" = 1 ] && echo selling-hydra.vk || echo purchasing-hydra.vk)"
  local other_cvk; other_cvk="$([ "$idx" = 1 ] && echo selling-cardano.vk || echo purchasing-cardano.vk)"
  ( "$NATIVE_BIN" \
      --node-id "$idx" \
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
      --blockfrost-query-timeout "${BLOCKFROST_QUERY_TIMEOUT:-10}" \
      --persistence-dir "$persist" \
      --contestation-period "${CONTESTATION_PERIOD:-220s}" \
      --deposit-period "${DEPOSIT_PERIOD:-300s}" \
      --unsynced-period "${UNSYNCED_PERIOD:-1800s}" \
      ${START_CHAIN_FROM:+--start-chain-from "${START_CHAIN_FROM//\//.}"} \
      ${PERSISTENCE_ROTATE_AFTER:+--persistence-rotate-after "$PERSISTENCE_ROTATE_AFTER"} \
      >>"$STATE/node$idx.log" 2>&1 ) &
  echo $! > "$STATE/node$idx.pid"
}

nodes_up(){
  ensure_bin
  if [ "$NETWORK" = preprod ]; then
    for f in blockfrost.txt protocol-parameters.json purchasing-cardano.sk purchasing-hydra.sk selling-cardano.sk selling-hydra.sk; do
      [ -f "$PREPROD_DIR/$f" ] || { c_red "missing $PREPROD_DIR/$f — run hydra-l2-flow/gen-preprod-keys.sh first"; exit 1; }
    done
    c_blu "Starting 2 native hydra-nodes on preprod (blockfrost)…"
    start_node_preprod 1 purchasing
    sleep 8
    start_node_preprod 2 selling
    c_blu "Waiting for node APIs (preprod chain sync can take longer than devnet)…"
    local ok=0
    for _ in $(seq 1 120); do
      if curl -s "http://127.0.0.1:4001/protocol-parameters" >/dev/null 2>&1 \
         && curl -s "http://127.0.0.1:4002/protocol-parameters" >/dev/null 2>&1; then ok=1; break; fi
      sleep 1
    done
    # return (not exit): nodes_restart's retry loop must be able to catch this
    # and try again — an exit here killed the whole restart on 2026-07-16 and
    # left a dead node1 behind for wait-sync to poll blindly.
    [ "$ok" = 1 ] && c_grn "  both node APIs up (4001/4002)" || { c_red "  node APIs did not come up — see $STATE/node1.log / node2.log"; return 1; }
    return 0
  fi

  [ -f "$DEMO/.env" ] || publish
  SCRIPTS_TX_ID="$(sed -n 's/^HYDRA_SCRIPTS_TX_ID=//p' "$DEMO/.env" | tr -d '[:space:]')"
  [ -n "$SCRIPTS_TX_ID" ] || { c_red "no HYDRA_SCRIPTS_TX_ID in $DEMO/.env (run: $0 publish)"; exit 1; }
  bridge_up

  if [ "${FRESH:-0}" = 1 ]; then
    c_blu "  FRESH=1 → clearing persistence"
    rm -rf "$DEMO/devnet/persistence/alice" "$DEMO/devnet/persistence/bob" "$DEMO/devnet/persistence/carol"
  fi
  mkdir -p "$DEMO/devnet/persistence/alice" "$DEMO/devnet/persistence/bob" "$DEMO/devnet/persistence/carol"

  c_blu "Starting 3 native hydra-nodes…"
  start_node 1 alice.sk bob.vk   carol.vk alice.sk bob.vk   carol.vk "$DEMO/devnet/persistence/alice"
  start_node 2 bob.sk   alice.vk carol.vk bob.sk   alice.vk carol.vk "$DEMO/devnet/persistence/bob"
  start_node 3 carol.sk alice.vk bob.vk   carol.sk alice.vk bob.vk   "$DEMO/devnet/persistence/carol"

  c_blu "Waiting for node APIs…"
  local ok=0
  for _ in $(seq 1 60); do
    if curl -s "http://127.0.0.1:4001/protocol-parameters" >/dev/null 2>&1 \
       && curl -s "http://127.0.0.1:4002/protocol-parameters" >/dev/null 2>&1 \
       && curl -s "http://127.0.0.1:4003/protocol-parameters" >/dev/null 2>&1; then ok=1; break; fi
    sleep 1
  done
  [ "$ok" = 1 ] && c_grn "  all 3 node APIs up (4001/4002/4003)" || { c_red "  node APIs did not come up — see $STATE/node*.log"; exit 1; }

  if [ "${HYDRA_KEEPALIVE:-0}" = 1 ]; then
    c_grn "  keeping native hydra-nodes attached; press Ctrl-C to stop"
    while kill -0 "$(cat "$STATE/node1.pid")" "$(cat "$STATE/node2.pid")" "$(cat "$STATE/node3.pid")" 2>/dev/null; do
      sleep 5
    done
    c_red "  a native hydra-node exited — see $STATE/node*.log"
    exit 1
  fi
}

nodes_down(){
  local max=3; [ "$NETWORK" = preprod ] && max=2
  for i in $(seq 1 $max); do
    if [ -f "$STATE/node$i.pid" ]; then kill "$(cat "$STATE/node$i.pid")" 2>/dev/null; rm -f "$STATE/node$i.pid"; fi
  done
  pkill -f "$NATIVE_BIN --node-id" 2>/dev/null
}

# ── drift / wait-sync / restart (preprod, blockfrost) ────────────────────────
# Hydra's Blockfrost chain-follower has two modes (Hydra/Chain/Blockfrost.hs;
# still true as of 2.3.0, tracked upstream as cardano-scaling/hydra#2753):
# a startup CATCH-UP loop that fetches blocks back-to-back at full API speed, and
# a steady-state POLL loop that sleeps one block-time (~20s on preprod) and then
# processes exactly ONE block. The poll loop therefore loses the per-block API
# latency (~17s/min measured) and can NEVER recover — but a node restart re-runs
# the catch-up loop and collapses drift to ~0 in a minute or two. These commands
# expose that as an operational lever: restart → wait-sync → act.

# node_drift <logfile> → seconds between now and the node's latest Tick chainTime
# (its observed L1 time). Prints 999999 when no Tick is found (e.g. right after
# a restart, before the first block is applied) so callers treat it as "behind".
node_drift(){
  python3 - "$1" <<'PY'
import sys, re, datetime
tick = None
try:
    with open(sys.argv[1], 'rb') as f:
        f.seek(0, 2); size = f.tell()
        # Busy escrow steps can flood megabytes of log between Ticks, so scan
        # backwards in growing windows until one is found (or the file starts).
        for window in (200_000, 2_000_000, 20_000_000, size):
            f.seek(max(0, size - window))
            for line in f.read().decode('utf-8', 'replace').splitlines():
                if '"Tick"' in line:
                    m = re.search(r'"chainTime":"([^"]+)"', line)
                    if m: tick = m.group(1)
            if tick is not None or window >= size:
                break
except OSError:
    pass
if tick is None:
    print(999999); sys.exit(0)
t = tick.rstrip('Z')
if '.' in t:
    head, frac = t.split('.', 1); t = f"{head}.{(frac + '000000')[:6]}"
else:
    t += '.000000'
chain = datetime.datetime.fromisoformat(t).replace(tzinfo=datetime.timezone.utc)
now = datetime.datetime.now(datetime.timezone.utc)
print(int((now - chain).total_seconds()))
PY
}

# Block until every preprod node's drift < DRIFT_TARGET (default 60s) or
# WAIT_SYNC_TIMEOUT (default 900s) elapses. No-op on devnet (no drift there).
wait_sync(){
  [ "$NETWORK" = preprod ] || { c_grn "wait-sync: devnet has no Blockfrost drift — nothing to wait for"; return 0; }
  # 180s default: the post-catch-up steady state oscillates 90-160s (each new
  # block resets drift to ~latency, then the one-block-per-poll loop bleeds
  # ~20s/cycle until the next block lands) — demanding less just flaps. 180s is
  # still far under the 600s unsynced gate, and the Close tx's validity is
  # anchored to a FRESH Blockfrost tip query, so it doesn't depend on drift.
  local target="${DRIFT_TARGET:-180}" timeout="${WAIT_SYNC_TIMEOUT:-900}" waited=0
  c_blu "waiting for node drift < ${target}s (timeout ${timeout}s)…"
  while :; do
    local worst=0 i d
    for i in 1 2; do
      # A dead node's log freezes, so its "drift" just tracks wall-clock — bail
      # out immediately instead of blind-polling for the full timeout.
      if ! { [ -f "$STATE/node$i.pid" ] && kill -0 "$(cat "$STATE/node$i.pid" 2>/dev/null)" 2>/dev/null; }; then
        c_red "  node$i is NOT RUNNING — wait-sync aborted (see $STATE/node$i.log)"
        return 1
      fi
      d="$(node_drift "$STATE/node$i.log")"
      [ "$d" -gt "$worst" ] && worst="$d"
    done
    if [ "$worst" -lt "$target" ]; then c_grn "  in sync (worst drift ${worst}s)"; return 0; fi
    if [ "$waited" -ge "$timeout" ]; then c_red "  wait-sync timed out (worst drift still ${worst}s)"; return 1; fi
    echo "  worst drift ${worst}s — catching up…"
    sleep 10; waited=$((waited+10))
  done
}

# Block (bounded) until neither node has a snapshot round in flight. Killing
# both nodes mid-round can strand it forever: the etcd network layer persists
# last-known-revision BEFORE the head logic durably processes a message
# (Hydra/Network/Etcd.hs waitMessages, at-most-once across restarts), so a
# ReqSn/AckSn lost in that window is never re-delivered and the protocol has
# no retry — every later tx then fails TxInvalid (observed 2026-07-16,
# recovered via POST /snapshot side-load). "In flight" = /snapshot/last-seen
# reports anything but LastSeenSnapshot/NoSeenSnapshot.
wait_no_inflight(){
  [ "$NETWORK" = preprod ] || return 0
  local waited=0 timeout="${INFLIGHT_TIMEOUT:-120}" busy port tag
  while [ "$waited" -lt "$timeout" ]; do
    busy=""
    for port in 4001 4002; do
      tag="$(curl -s --max-time 5 "http://127.0.0.1:$port/snapshot/last-seen" 2>/dev/null | grep -o '"tag":"[^"]*"')"
      case "$tag" in
        '"tag":"LastSeenSnapshot"'|'"tag":"NoSeenSnapshot"'|"") ;; # idle or unreachable
        *) busy="$port:$tag" ;;
      esac
    done
    [ -z "$busy" ] && return 0
    [ "$waited" = 0 ] && c_blu "  snapshot round in flight ($busy) — delaying restart up to ${timeout}s…"
    sleep 5; waited=$((waited+5))
  done
  c_red "  restart proceeding with round STILL in flight ($busy) — may need POST /snapshot side-load recovery"
  return 0
}

# Restart the nodes in place (persistence intact → the open head survives; the
# restarted follower re-runs its catch-up burst).
nodes_restart(){
  local try
  wait_no_inflight
  for try in 1 2 3; do
    nodes_down
    # Wait for the old processes to actually die and their ports (api/etcd) to
    # be released — a 5s flat sleep proved too short (2026-07-02: restart #1
    # silently failed to bind, leaving 17 min of dead air until the next guard).
    local waited=0
    while pgrep -f "$NATIVE_BIN --node-id" >/dev/null 2>&1 && [ "$waited" -lt 30 ]; do
      sleep 2; waited=$((waited+2))
    done
    sleep 5
    if ! nodes_up; then
      c_red "  restart try $try: nodes_up failed — retrying"
      continue
    fi
    # Verify the fresh nodes are actually WRITING (API up alone is not enough —
    # a wedged chain layer serves /protocol-parameters but never ticks).
    local lines0; lines0="$(wc -l < "$STATE/node1.log" 2>/dev/null || echo 0)"
    sleep 20
    local lines1; lines1="$(wc -l < "$STATE/node1.log" 2>/dev/null || echo 0)"
    if [ "$((lines1 - lines0))" -ge 3 ]; then
      c_grn "  restart verified (node1 log advancing)"
      return 0
    fi
    c_red "  restart try $try: node1 log silent after 20s — retrying"
  done
  c_red "  restart FAILED after 3 tries"
  return 1
}

status(){
  echo "binary : $([ -x "$NATIVE_BIN" ] && "$NATIVE_BIN" --version 2>/dev/null | head -1 || echo 'not installed')"
  echo "bridge : $(docker ps --filter "name=^${BRIDGE_NAME}$" --format '{{.Status}}' 2>/dev/null || echo down)"
  echo "socket : $([ -S "$HOST_SOCKET" ] && echo "$HOST_SOCKET" || echo missing)"
  for i in 1 2 3; do
    local up=down; [ -f "$STATE/node$i.pid" ] && kill -0 "$(cat "$STATE/node$i.pid" 2>/dev/null)" 2>/dev/null && up=up
    local api=down; curl -s "http://127.0.0.1:$((4000+i))/protocol-parameters" >/dev/null 2>&1 && api=up
    echo "node$i  : proc=$up api=$api (http://127.0.0.1:$((4000+i)))"
  done
}

if [ "$NETWORK" = devnet ]; then
  [ -d "$DEMO" ] || { c_red "hydra demo dir not found (set HYDRA_DEMO_DIR): $DEMO"; exit 1; }
fi

case "${1:-}" in
  bin)       ensure_bin ;;
  publish)   publish ;;
  up)        nodes_up ;;
  down)      nodes_down; [ "$NETWORK" = devnet ] && bridge_down; c_grn "native hydra layer down" ;;
  restart)   nodes_restart ;;
  wait-sync) wait_sync ;;
  drift)     node_drift "$STATE/node${2:-1}.log" ;;
  status)    status ;;
  *) echo "usage: $0 {up|down|restart|wait-sync|drift [n]|status|publish|bin}"; exit 1 ;;
esac
