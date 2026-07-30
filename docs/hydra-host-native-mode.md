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

A container on an arm64 Mac runs Linux, so it needs a *Linux* `hydra-node`, and
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
own `hydra-node`, executes the *same application code* as the image — config,
registry, port allocation, supervisor, plan/drain/drift/unwedge, node client,
auth, routes, provisioning, and the proxy. Three environment variables differ,
and all three are configuration rather than code paths:

| Variable | Container | Native (macOS) |
| --- | --- | --- |
| `HYDRA_NODE_BIN` | `/usr/local/bin/hydra-node` (baked, amd64 Linux) | path to the Darwin arm64 build |
| `HYDRA_HOST_DATA_DIR` | `/data` volume | a local directory |
| `HYDRA_HOST_USE_SYSTEM_ETCD` | `true` — the image bakes a matching etcd 3.5.25 | `false` — let `hydra-node` extract its own |

Native mode is a supported way to run the Host, not a workaround. It is also
the right choice on arm64 Linux servers until upstream publishes a build for
them.

## What the container still covers exclusively

Running natively verifies the logic; it does not verify the image. The
container additionally covers the build itself, the baked binaries being on
`PATH`, the non-root user, volume permissions, and `--network host`. The one
path that only an amd64 machine can exercise is a node reaching `Running`
*inside* the container using the baked etcd — the baked version matches the one
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
