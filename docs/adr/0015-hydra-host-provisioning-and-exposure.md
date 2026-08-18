# ADR 0015 — Hydra Host: API-driven node provisioning and exposure model

## Status

Proposed.

## Context

Hydra nodes are currently launched by `hydra-l2-flow/hydra-native.sh` on a
single machine, and the payment service learns about them through
`HYDRA_*` environment variables consumed by `prisma/seed.ts`. That does not
survive contact with production: there is no way to add a head without an
operator editing env and redeploying, no way to run heads across more than one
machine, and no authentication in front of a node.

Four properties of `hydra-node` 2.3.0 constrain any solution. All were verified
against the pinned binary and the running preprod nodes, not assumed:

- **One process per head.** Upstream `#383` ("multiple heads per hydra-node")
  is closed as _not planned_. N heads means N processes, each with its own
  `--persistence-dir`, `--api-port` and `--listen` port.
- **Peer traffic is etcd, not HTTP-on-a-path.** `--listen` is an embedded etcd
  peer address and `--peer host:port` becomes etcd's `--initial-cluster`.
  Observed live: ports 4001/4002 are owned by `hydra-node` (the WS + HTTP API),
  while 5001/5002 are owned by `etcd` child processes exchanging raft streams.
  The etcd client port is derived as `2379 + (listenPort - 5001)` and binds
  loopback only, so distinct `--listen` ports let many nodes share one network
  namespace.
- **There is no authentication, and no peer encryption.** The node API has no
  auth of any kind, and `GET /config` (new in 2.3.0) discloses signing-key
  paths. `Hydra/Network/Etcd.hs` passes no TLS flags to etcd and carries the
  comment `-- XXX: Could use TLS to secure peer connections`. Peer messages are
  _signed_ (forgery is blocked) but not _encrypted_.
- **Persistence is authoritative and non-rotatable.** `hydra.db` plus the etcd
  WAL are the head state; the service permanently fail-closes a session that
  emits `EventLogRotated`, so rotation stays disabled and the log grows without
  bound. Losing the directory loses the head.

## Decision

Introduce a **Hydra Host**: one container image that supervises per-head
`hydra-node` processes and exposes a token-gated control-plane API. The payment
service is given only a host URL plus credentials, and drives the full node
lifecycle over that API. A `HydraHost` registry row makes several hosts usable
side by side.

**1. Two exposure planes.** The control plane (node API + management) sits
behind an authenticating reverse proxy on a single published port, with TLS
terminated by the platform load balancer. The peer plane is published directly,
one port per head, bypassing the proxy — a path-based proxy cannot carry etcd
raft. The peer port is protected by a per-head IP allowlist, which costs
nothing because the counterparty's address must already be known to set
`--peer`. Peers are configured by **hostname** so a counterparty IP change is
absorbed by DNS rather than forcing a restart.

**2. Two token tiers.** The admin token covers fleet operations — provision,
escrow-ack, delete, reconfigure, read capabilities. The user token covers
operating an existing node, including the whole proxied API and WebSocket. WS
frames are deliberately _not_ tag-gated: `Init`, `Close` and `Fanout` share the
single long-lived socket with the event stream (`node.ts:1246`, `:1524`,
`:1534`), so gating them would force that socket to admin and leave the user
tier unused. The residual risk is bounded — a leaked user token can close a
head, which settles funds on L1 per the last snapshot; it cannot exfiltrate
keys or provision nodes.

**3. Host generates keys and discloses them exactly once.** Provisioning is
two-phase: `POST /v1/nodes` carries a caller-supplied idempotency key, the host
generates the Hydra and Cardano keys and returns them while holding the node in
`pending-escrow` without starting it; the payment service persists them
encrypted; `POST /v1/nodes/{id}/escrow-ack` then starts the node and
permanently seals the disclosure path. Retrying with the same idempotency key
re-returns the material only while un-acked, and un-acked nodes are reaped.

This **revises the stance recorded at `prisma/schema.prisma:1671-1677`**, which
kept the node's Cardano key out of the service entirely. That rationale — a
node-host compromise must not reach escrowed funds — still holds and is
unchanged in direction: the key now lives in both places rather than only on
the host, accepted because host and payment service are one security domain and
because an escrowed copy is what makes a destroyed host rebuildable.

**4. Restart is supervised, and recovery is automatic because draining cannot
be guaranteed.** Stopping a node mid-snapshot-round can strand it: etcd
persists `last-known-revision` before the head logic durably consumes the
message, so a lost `ReqSn`/`AckSn` is never redelivered and later txs fail
`TxInvalid`. The supervisor therefore drains before any _voluntary_ stop,
polling `/snapshot/last-seen` until `LastSeenSnapshot`/`NoSeenSnapshot`.

But a container can always be killed involuntarily — OOM, host failure,
platform eviction — so **draining is a probability reduction, not a guarantee**,
and correctness rests on recovery rather than on clean shutdown. Recovery is
automatic and needs no operator:

| Level | Situation                             | Action                                                                        |
| ----- | ------------------------------------- | ----------------------------------------------------------------------------- |
| 0     | process crash, volume intact          | restart with backoff; `hydra.db` replays, etcd resumes its WAL                |
| 1     | container/host SIGKILL                | identical to level 0 on next boot                                             |
| 2     | restarted but snapshot round stranded | detect, then side-load the node's own confirmed snapshot via `POST /snapshot` |
| 3     | offline past etcd's compaction window | same side-load path                                                           |
| 4     | persistence volume destroyed          | restore a volume snapshot plus the escrowed keys — the only manual case       |

The level-2/3 procedure is not new: it is already proven in
`hydra-l2-flow/run-hydra-e2e.sh:909-921`, which detects a stranded round and
side-loads to un-wedge it. This work moves it from the harness into the
supervisor. It is self-contained — the snapshot comes from the node's own last
confirmed state, so no counterparty action is required. Safety is preserved
because the service refuses to treat `SnapshotSideLoaded` as a replay
authentication anchor (`docs/hydra-architecture.md:201`), so side-loading can
restore a node without becoming a channel for injecting unverified state.

The supervisor also owns a **drift watchdog**: on Blockfrost the chain follower
loses ≈17 s per minute with no catch-up path (upstream `#2753`), and past
`--unsynced-period` the node rejects all input with
`RejectedInputBecauseUnsynced`, recoverable only by restart.

**4b. One node per Head, which makes a cross-org handshake mandatory.** A
hydra-node serves exactly one Head and is provisioned with fresh keys and a
fresh peer port each time. Because `--peer`, `--hydra-verification-key` and
`--initial-cluster` are all startup configuration — and the etcd data dir is
content-addressed by that configuration — both participants must agree the
full cluster config _before either node boots_. They need not act
simultaneously, but the agreement is a precondition, so each Head requires an
exchange of public material between the two operators.

Manual exchange does not scale per Head, so the handshake becomes an API. It is
authenticated by **signature, not by a shared credential**: an offer is signed
by the offering side's Relation wallet key and verified against
`HydraRelation.RemoteWallet.walletVkey`, reusing the mechanism that already
authenticates a seller's `blockchainIdentifier` to a buyer
(`src/routes/api/purchases/shared.ts:233`). Only verification keys and an
advertise address cross the boundary; no signing key leaves its Host. A
deterministic tie-break — lower-sorting wallet vkey is the initiator — collapses
simultaneous proposals for the same Head slot.

The alternative, one node per Relation reused across sequential Heads, would
have reduced the exchange to once per counterparty. It was rejected in favour
of per-Head key isolation and a clean persistence directory per Head.

**5. A head is pinned to its host for life.** Persistence is not relocatable, so
placement happens once at provisioning and the head stays there. Process,
container and VM restarts recover automatically from the intact volume; only
destruction of the volume itself requires the escrowed keys plus a snapshot
backup. Draining a host means closing its heads, not migrating them.

**6. Ledger protocol parameters are baked into the image from this repo.** The
L2 params must match the Mesh cost models pinned by
`packages/payment-source-v2` (297-entry PlutusV3) or in-head script spends fail
`PPViewHashesDontMatch`. Building the host image inside this repo keeps both
artefacts on one pin, with a CI drift guard; the host additionally reports a
params hash via `/v1/capabilities` so the service refuses to provision against
a skewed host.

**7. Durable block storage is required, and TLS terminates outside the
container.** A platform with an ephemeral filesystem cannot host a node:
persistence is a SQLite event store plus an etcd raft WAL, both of which need
real POSIX fsync durability, and etcd expects local disk rather than a network
filesystem. This rules out **DigitalOcean App Platform**, which offers no
persistent volumes. Periodically checkpointing to object storage does not
rescue it, because an involuntary kill between checkpoints loses exactly the
head state whose loss is unrecoverable.

The target is therefore a droplet with an attached Block Storage volume mounted
at `/data`, with volume snapshots covering level-4 recovery. The image stays
**orchestrator-agnostic** — all durable state under a single mount point, clean
SIGTERM handling, no host assumptions — so moving to DOKS with a StatefulSet
and per-node PVCs later is a deployment change rather than a rewrite.

TLS is **not** the container's concern: it serves plain HTTP on the control
plane and honours `X-Forwarded-Proto`, while a managed load balancer (or an
ingress, or a separate reverse-proxy container) terminates. Keeping ACME state
out of the image avoids giving the container a second thing that would need
durable storage. A managed load balancer also preserves the single-command
deployment goal, which a sidecar proxy would not. The peer plane bypasses this
entirely — it has no TLS upstream, and per-head dynamic TCP ports behind a
managed load balancer would be unworkable, so peer ports are exposed directly
on the host IP under a firewall allowlist.

## Consequences

- The payment service must learn to authenticate to a node. `HydraNodeConfig`
  (`src/lib/hydra/hydra/types.ts:128-137`) has no credential field, the WS is
  built with no headers (`connection.ts:45-48`), and `node-url.ts:85-87`
  actively rejects URLs containing userinfo. Threading a bearer token through
  config → connection → client is a typed change, not configuration.
- `HydraLocalParticipant.nodeUrl` / `nodeHttpUrl` become **derived** from the
  host URL plus an assigned node id, rather than hand-entered.
- Peer traffic remains readable on the wire. An on-path observer learns in-head
  activity in real time that would otherwise surface only at settlement. This
  is accepted for now; because `--listen` and `--advertise` are independently
  configurable, a tunnel can be introduced later as pure configuration.
- Port allocation must be durable and released on head removal. Under Docker
  port publishing the published range is a hard ceiling, so production uses
  `--network host` to lift it; a published range remains the dev fallback.
- Two-party heads tolerate zero mirror nodes (`k < ⌊n/2⌋` gives 0 at n=2), so
  the documented Hydra HA pattern does not apply at this head size.
