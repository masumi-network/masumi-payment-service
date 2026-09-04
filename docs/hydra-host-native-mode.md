# Running a Hydra Host natively

The Hydra Host normally ships as a container. On macOS it cannot, and the
reason is worth stating precisely because it looks like a packaging problem and
is not.

## Why there is no container on macOS

The image bakes `hydra-node` — that is the whole point of it, since the Host's
job is to supervise one `hydra-node` process per Head. Upstream publishes
exactly two builds:

- `hydra-x86_64-linux-<version>.zip`
- `hydra-aarch64-darwin-<version>.zip`

There is no `aarch64-linux` build, and the official image
`ghcr.io/cardano-scaling/hydra-node:<version>` is a single `linux/amd64`
manifest rather than a multi-arch one.

A container on an arm64 Mac runs Linux, so it needs a _Linux_ `hydra-node`, and
the only one that exists is amd64. Under Docker Desktop's emulation that binary
dies with `SIGILL` (exit 132) the moment it touches its crypto path —
`--version` succeeds, `--hydra-script-catalogue` does not. Changing the base
image does not help: the missing thing is the binary, not the distribution
around it.

Building `hydra-node` for `aarch64-linux` from its Nix flake is possible in
principle (haskell.nix plus a Rust accumulator), but it compiles GHC and Rust
largely from source, and it produces an unofficial binary whose script hashes
would have to be verified against `HYDRA_DEPOSIT_SCRIPT_HASH` and
`HYDRA_HEAD_SCRIPT_HASH` before any Head opened with it could interoperate.

## What native mode is

The Host is a plain Node process. Running it directly, pointed at the platform's
own `hydra-node`, executes the _same application code_ as the image — config,
registry, port allocation, supervisor, plan/drain/drift/unwedge, node client,
auth, routes, provisioning, and the proxy. Three environment variables differ,
and all three are configuration rather than code paths:

| Variable                     | Container                                        | Native (macOS)                             |
| ---------------------------- | ------------------------------------------------ | ------------------------------------------ |
| `HYDRA_NODE_BIN`             | `/usr/local/bin/hydra-node` (baked, amd64 Linux) | path to the Darwin arm64 build             |
| `HYDRA_HOST_DATA_DIR`        | `/data` volume                                   | a local directory                          |
| `HYDRA_HOST_USE_SYSTEM_ETCD` | `true` — the image bakes a matching etcd 3.5.25  | `false` — let `hydra-node` extract its own |

Native mode is a supported way to run the Host, not a workaround.

## Running it

Two arm64 cases, and they are not the same problem:

- **macOS on Apple silicon** — upstream publishes `aarch64-darwin`, so this
  works today. Everything below applies.
- **arm64 Linux** — upstream publishes _no_ build, so there is nothing to point
  `HYDRA_NODE_BIN` at. Native mode does not rescue this: you would have to
  build `hydra-node` from its Nix flake and verify the resulting script hashes
  against `HYDRA_DEPOSIT_SCRIPT_HASH` and `HYDRA_HEAD_SCRIPT_HASH` before any
  head opened with it could interoperate. Use amd64 Linux instead unless you
  are prepared to do that.

### 1. Fetch `hydra-node`

```bash
HYDRA_VERSION=2.3.0
HYDRA_SHA256=a9074d0b69cc7104ccad672c942da7c0c695b4dbdff5002fd503904fe24ad528
curl --proto '=https' --tlsv1.2 -fsSL -o hydra.zip \
  "https://github.com/cardano-scaling/hydra/releases/download/${HYDRA_VERSION}/hydra-aarch64-darwin-${HYDRA_VERSION}.zip"
printf '%s  %s\n' "$HYDRA_SHA256" hydra.zip | shasum -a 256 -c -
unzip -j hydra.zip -d .bin
chmod +x .bin/hydra-node
.bin/hydra-node --version
```

The checksum above is the SHA-256 digest reported by the official Hydra 2.3.0
release API on 2026-09-04. Review and replace both the version and digest
together when upgrading.

Both sides of a head must run the same version, so pin it rather than tracking
latest.

### 2. Start the Host

```bash
HYDRA_HOST_PUBLIC_HOST=hydra.example.com \
HYDRA_HOST_PUBLIC_EXCHANGE_URL=http://127.0.0.1:8444/exchange \
HYDRA_HOST_NETWORK=preprod \
HYDRA_HOST_ADMIN_TOKEN="$(openssl rand -hex 32)" \
HYDRA_HOST_USER_TOKEN="$(openssl rand -hex 32)" \
HYDRA_NODE_BIN="$PWD/.bin/hydra-node" \
HYDRA_HOST_DATA_DIR="$PWD/.hydra-data" \
BLOCKFROST_PROJECT_FILE="$PWD/blockfrost.txt" \
HYDRA_HOST_LEDGER_PARAMS_FILE="$PWD/packages/hydra-host/params/preprod.json" \
HYDRA_HOST_USE_SYSTEM_ETCD=false \
pnpm exec tsx packages/hydra-host/src/index.ts
```

The loopback Exchange Plane URL is for a local native run. A reachable Host
must use its public HTTPS Exchange Plane URL.

Four of those differ from the container and are worth understanding:

|                                    | Why                                                                                                                                                                                                                                                                                                                                                             |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `HYDRA_NODE_BIN`                   | Nothing is baked in, so the path is yours to supply.                                                                                                                                                                                                                                                                                                            |
| `HYDRA_HOST_DATA_DIR`              | Defaults to `/data`, which is the container's volume. Point it somewhere real and back it up: it holds the event store and the raft WAL.                                                                                                                                                                                                                        |
| `HYDRA_HOST_LEDGER_PARAMS_FILE`    | Defaults to `/opt/hydra/params/<network>.json`, which only exists in the image. Use the reviewed file that ships in `packages/hydra-host/params/` — any other params file, however plausible, makes every payment service refuse the Host.                                                                                                                      |
| `HYDRA_HOST_USE_SYSTEM_ETCD=false` | Required, and it defaults to `true`. There is no system etcd outside the image, so leaving the default means every node dies seconds after starting; let `hydra-node` extract the copy it embeds instead. Setting `true` against a different etcd version risks subtle raft incompatibilities. The Host refuses to boot if this is on and no `etcd` is on PATH. |

`BLOCKFROST_PROJECT_FILE` is a path to a file containing the project id, not
the id itself, in native mode as in the container.

Everything else — ports, tokens, the peer allow-list — behaves exactly as it
does in the container. See the
[Hydra Operations Guide](hydra-operations.md) for those.

One difference is worth stating, because it is easy to read as "already handled".
There is no container here, so there is no port publication and no
`docker-compose.public-peer.yml` to gate the peer range behind. The peer ports
are simply open on the machine as soon as a node starts. The nftables ruleset
from `GET /v1/peer-allowlist`, plus whatever firewall sits in front of the
machine, is the entire protection for an unauthenticated etcd raft plane. Apply
it before provisioning the first node, and re-apply whenever peer membership or
DNS changes. The generated ruleset covers this case: it emits an `input` chain
alongside the `forward` chain that Docker bridge traffic needs.

### 3. Keep it running

There is no supervisor around the supervisor here. Use whatever the machine
already has — `launchd` on macOS, `systemd` on Linux — and give it a **stop
timeout of about four minutes** (250s), because the Host drains a snapshot round
before exiting and etcd's raft WAL does not tolerate being cut off mid-round.
Native mode runs the same binary with the same defaults as the container: a node
that will not drain takes 120s, then 30s before SIGKILL, then 5s waiting on it,
and the Host gives up on its own drain at 240s. A two-minute timeout kills it
before a single stuck node has finished.

## What the container still covers exclusively

Running natively verifies the logic; it does not verify the image. The
container additionally covers the build itself, the baked binaries being on
`PATH`, the non-root user, volume permissions, and `--network host`. The one
path that only an amd64 machine can exercise is a node reaching `Running`
_inside_ the container using the baked etcd — the baked version matches the one
`hydra-node` embeds, but a version match is not proof it runs.

## Running the end-to-end suite

```bash
pnpm exec tsx scripts/hydra-e2e/run.mts
```

This brings up two Hosts, provisions a node on each, peers them into one etcd
cluster, and exercises the control plane, the proxy, the node lifecycle, Host
crash recovery, and the cross-organisation handshake through a real payment
service. See [scripts/hydra-e2e/README.md](../scripts/hydra-e2e/README.md) for
prerequisites, what each phase asserts, and the opt-in phase that opens a real
Head on preprod.
