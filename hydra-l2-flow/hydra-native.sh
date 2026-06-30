#!/usr/bin/env bash
#
# hydra-native.sh — run Hydra 2.2.0 hydra-nodes NATIVELY on Apple Silicon.
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
#   ./hydra-native.sh up      # bridge + 3 native nodes (publish-scripts first if needed)
#   ./hydra-native.sh down    # stop nodes + bridge
#   ./hydra-native.sh status  # show node/bridge/API state
#   ./hydra-native.sh publish # (re)publish 2.2.0 reference scripts natively -> $DEMO/.env
#   ./hydra-native.sh bin     # ensure native binary is present (download if missing)
#
set -uo pipefail

REPO="${REPO:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
DEMO="${DEMO:-${HYDRA_DEMO_DIR:-$( \
  for d in "$REPO/../hydra/demo" "$REPO/../../hydra/demo"; do \
    [ -d "$d" ] && { (cd "$d" && pwd); break; }; \
  done )}}"

HYDRA_VERSION="${HYDRA_VERSION:-2.2.0}"
# CI run that produced the native binaries for this release (no GitHub release
# assets exist; the binaries are published as workflow artifacts).
HYDRA_BIN_RUN_ID="${HYDRA_BIN_RUN_ID:-27418396480}"
HYDRA_BIN_ARTIFACT="${HYDRA_BIN_ARTIFACT:-hydra-aarch64-darwin-${HYDRA_VERSION}}"

BIN_DIR="${BIN_DIR:-$REPO/hydra-l2-flow/.bin}"
NATIVE_BIN="${NATIVE_BIN:-$BIN_DIR/hydra-node}"
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
    return 0
  fi
  command -v gh >/dev/null 2>&1 || { c_red "missing: gh (needed to download the native binary artifact)"; exit 1; }
  c_blu "Downloading native $HYDRA_BIN_ARTIFACT (CI artifact, ~176 MiB)…"
  local tmp; tmp="$(mktemp -d)"
  gh run download "$HYDRA_BIN_RUN_ID" --repo cardano-scaling/hydra \
    --name "$HYDRA_BIN_ARTIFACT" --dir "$tmp" || { c_red "download failed"; exit 1; }
  [ -f "$tmp/hydra-node" ] || { c_red "artifact missing hydra-node"; exit 1; }
  install -m 0755 "$tmp/hydra-node" "$NATIVE_BIN"
  [ -f "$tmp/hydra-tui" ] && install -m 0755 "$tmp/hydra-tui" "$BIN_DIR/hydra-tui"
  rm -rf "$tmp"
  c_grn "  installed -> $NATIVE_BIN ($("$NATIVE_BIN" --version 2>/dev/null | head -1))"
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
    python3 "$STATE/n2c-forward.py" "$HOST_SOCKET" "$BRIDGE_PORT" >"$STATE/forwarder.log" 2>&1 &
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
  ( cd "$DEMO" && "$NATIVE_BIN" \
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
      >"$STATE/node$idx.log" 2>&1 ) &
  echo $! > "$STATE/node$idx.pid"
}

nodes_up(){
  ensure_bin
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
}

nodes_down(){
  for i in 1 2 3; do
    if [ -f "$STATE/node$i.pid" ]; then kill "$(cat "$STATE/node$i.pid")" 2>/dev/null; rm -f "$STATE/node$i.pid"; fi
  done
  # also sweep any stragglers bound to our ports
  pkill -f "$NATIVE_BIN --node-id" 2>/dev/null
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

[ -d "$DEMO" ] || { c_red "hydra demo dir not found (set HYDRA_DEMO_DIR): $DEMO"; exit 1; }

case "${1:-}" in
  bin)     ensure_bin ;;
  publish) publish ;;
  up)      nodes_up ;;
  down)    nodes_down; bridge_down; c_grn "native hydra layer down" ;;
  status)  status ;;
  *) echo "usage: $0 {up|down|status|publish|bin}"; exit 1 ;;
esac
