# ADR 0010 — Hydra Host: API-driven node provisioning and exposure model

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
  is closed as *not planned*. N heads means N processes, each with its own
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
  *signed* (forgery is blocked) but not *encrypted*.
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
frames are deliberately *not* tag-gated: `Init`, `Close` and `Fanout` share the
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

**4. Restart is supervised, never delegated to Docker.** `--restart=always` and
plain SIGKILL are unsafe: killing a node mid-snapshot-round can strand the head
permanently, because etcd persists `last-known-revision` before the head logic
durably consumes the message, so a lost `ReqSn`/`AckSn` is never redelivered.
The supervisor drains first — polling `/snapshot/last-seen` until
`LastSeenSnapshot`/`NoSeenSnapshot` — then stops, restarts and waits for sync.
It also owns a **drift watchdog**: on Blockfrost the chain follower loses ≈17 s
per minute with no catch-up path (upstream `#2753`), and past
`--unsynced-period` the node rejects all input with
`RejectedInputBecauseUnsynced`, recoverable only by restart.

**4b. One node per Head, which makes a cross-org handshake mandatory.** A
hydra-node serves exactly one Head and is provisioned with fresh keys and a
fresh peer port each time. Because `--peer`, `--hydra-verification-key` and
`--initial-cluster` are all startup configuration — and the etcd data dir is
content-addressed by that configuration — both participants must agree the
full cluster config *before either node boots*. They need not act
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
