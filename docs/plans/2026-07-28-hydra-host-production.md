# Hydra Host — production packaging and API-driven head operations

Status: **draft for grilling** (2026-07-28)
Branch: `gd/hydra-node-ops` (stacked on `gd/impl-hydra`)

## Goal

Turn the bash-launched, single-machine, env-seeded Hydra setup into a
deployable **Hydra Host**: one container, one `docker run`, exposing a
token-gated API that the Masumi payment node uses to provision, operate and
observe hydra-nodes — with several hosts usable side by side for horizontal
scale.

## 1. Ground truth that constrains the design

Established from the pinned binary (`hydra-node 2.3.0`), the launcher
(`hydra-l2-flow/hydra-native.sh`) and the service (`docs/hydra-architecture.md`,
`prisma/schema.prisma:1500-1882`).

### 1.1 A hydra-node serves exactly one head

One process = one `--persistence-dir`, one hydra signing key, one peer set.
N heads therefore means N processes, each with its own api / listen /
monitoring port and its own persistence directory. Any "host" is inherently a
**process supervisor**, not a single daemon.

### 1.2 Peer traffic is etcd, not HTTP

`--listen` is an embedded **etcd** peer address and `--peer host:port` points at
the counterparty's `--listen`. That link is raft/gRPC over TCP.

**Consequence: the counterparty-facing route cannot be a path on an HTTP
reverse proxy.** The deployment has two distinct planes:

| Plane             | Traffic                      | Exposure                      | Auth                                          |
| ----------------- | ---------------------------- | ----------------------------- | --------------------------------------------- |
| **Peer plane**    | etcd raft, one port per head | L4/TCP, per-head port, public | network-level (allowlist / VPN / mTLS tunnel) |
| **Control plane** | hydra-node API (WS + HTTP)   | L7, one published port        | bearer token (user / admin)                   |

Three flags make this tractable, and they are the backbone of the container:

- `--advertise HOST:PORT` — decouples the bind address from the publicly
  advertised endpoint. Without it, etcd would advertise a container-internal
  address to the counterparty. **This is what makes Docker + NAT viable.**
- `--tls-cert` / `--tls-key` — node-native WSS/HTTPS. TLS can terminate at the
  node or at the proxy, but hydra-node still has **no authentication of any
  kind**, so the token gate must live in front of it.
- `--use-system-etcd` — use an etcd baked into the image instead of extracting
  one into the persistence dir on every boot. Removes a
  write-executable-into-the-volume requirement and a restart race.

### 1.3 The Blockfrost follower drifts and only a restart fixes it

Not in the original ask, but it is the single biggest production risk.

On preprod/mainnet the node runs without a cardano-node (`--blockfrost FILE`).
Its steady-state follower sleeps one block-time then processes **exactly one
block**, losing ≈17 s per minute with no catch-up path (upstream
`cardano-scaling/hydra#2753`, still open in 2.3.0). Past `--unsynced-period`
the node rejects _all_ client input with `RejectedInputBecauseUnsynced`.

Today the mitigation is bash: `hydra-native.sh drift|wait-sync|restart`, which
parses `chainTime` out of the node's **stdout log file** and restarts.

**A restart is not safe on its own.** Killing a node mid-snapshot-round can
strand the head permanently: the etcd layer persists `last-known-revision`
before the head logic durably consumes the message (at-most-once across
restarts), so a lost `ReqSn`/`AckSn` is never redelivered and every later tx
fails `TxInvalid`. The launcher therefore drains first — polling
`/snapshot/last-seen` until `LastSeenSnapshot`/`NoSeenSnapshot`.

So the host must own a **drift watchdog**: measure drift → drain in-flight →
restart → wait for sync, per head, with backoff and alerting. This is
non-optional supervision, and it must not read stdout logs.

### 1.4 Persistence is durable, non-rotatable, non-relocatable

`--persistence-dir` holds the SQLite event log (authoritative head state),
etcd's raft WAL, `last-known-revision` and `pending-broadcast/`.

- Rotation is **categorically unsupported** — the service permanently
  fail-closes a session that emits `EventLogRotated`, because compaction can
  discard the Open / signed-snapshot anchors its authenticated replay needs.
  So the log grows without bound: disk is a capacity-planning input.
- Losing it loses the head. Key escrow alone does **not** give disaster
  recovery — closing needs the latest signed snapshot, which lives here.
  The real recovery unit is **(keys + persistence dir)**.
- Therefore a head is **pinned to the host that holds its directory**. Heads
  are not freely reschedulable; placement is a one-time decision with affinity.

### 1.5 The payment service cannot currently authenticate to a node

`HydraNodeConfig` (`src/lib/hydra/hydra/types.ts:128-137`) has no header,
credential or token field. The WS is built with only `{ maxPayload,
perMessageDeflate: false }` (`connection.ts:45-48`), HTTP calls send only
`Content-Type`, and `node-url.ts:85-87` actively **rejects** URLs containing
userinfo. Adding a bearer token is a typed change through
config → connection → node client, not a config tweak.

It already requires TLS for any non-loopback host, with
`HYDRA_TRUSTED_PLAINTEXT_HOSTS` as the documented escape hatch — which aligns
with putting nodes behind an HTTPS endpoint.

### 1.6 Two version couplings cross the image boundary

- `HYDRA_DEPOSIT_SCRIPT_HASH` / `HYDRA_HEAD_SCRIPT_HASH` must match
  `hydra-node --hydra-script-catalogue` for the deployed binary.
- `--ledger-protocol-parameters` must match the Mesh SDK cost models pinned in
  the service (297-entry PlutusV3), or in-head script spends fail
  `PPViewHashesDontMatch`.

If the node ships as its own image, both couplings become cross-image
contracts and must be **verified at provision time**, not assumed.

### 1.7 Existing domain vocabulary to respect

- `HydraRelation` — a singular **two-party channel**; one non-Final head at a
  time (partial unique index); heads are sequential.
- `HydraLocalParticipant` / `HydraRemoteParticipant` — **"local" means
  secret-holding, "remote" means observed-only**, not network locality. The
  service never dials a remote node; `HydraRemoteParticipant.nodeUrl` is
  write-only metadata.
- `cardanoVkey` (28-byte hash, the node's on-chain identity) is deliberately
  **not** the funding `HotWallet` — documented at `schema.prisma:1671-1677` so
  that a node-host compromise cannot reach escrowed funds.
- `hydraSK` is caller-supplied, encrypted at rest, and **never exported**; it is
  decrypted only to derive the public key.
- There is no `HydraNode` entity today, and no notion of a host.

## 2. Proposed architecture

### 2.1 The Hydra Host container

One image, one command, one supervisor process tree.

```
masumi/hydra-host:<hydra-version>
├── control-plane (the only published HTTP port)
│   ├── token auth: admin vs user
│   ├── reverse proxy → child node API (WS + HTTP)
│   ├── node lifecycle API (provision / list / start / stop / delete)
│   └── supervisor: drift watchdog, drain-before-restart, health
├── hydra-node × N   (one per head; own keys, ports, persistence)
└── etcd             (baked in, used via --use-system-etcd)
```

Single command, no compose:

```bash
docker run -d --name hydra-host \
  -v hydra-host-data:/data \
  -p 8443:8443 \
  -p 5001-5032:5001-5032 \
  -e HYDRA_HOST_PUBLIC_HOST=hydra1.example.com \
  -e HYDRA_HOST_ADMIN_TOKEN=... \
  -e HYDRA_HOST_USER_TOKEN=... \
  -e BLOCKFROST_PROJECT_ID=... \
  masumi/hydra-host:2.3.0
```

`/data` is the durable volume: `/data/nodes/<nodeId>/{keys,persistence,config}`.
The published peer range bounds heads-per-host; `PUBLIC_HOST` feeds
`--advertise` so the counterparty gets a reachable address.

### 2.2 Control-plane API

Two tiers, as requested:

- **user token** — runtime operation: the proxied node API (WS, `/commit`,
  `/cardano-transaction`, `/snapshot/*`, `/protocol-parameters`), plus node
  status reads.
- **admin token** — provisioning, key material, configuration, deletion.

```
# admin
POST   /v1/nodes                     provision: generate keys, allocate ports,
                                     write config, start; returns nodeId,
                                     hydraVK, cardanoVkey, advertise address
GET    /v1/nodes                     list + status + capacity
GET    /v1/nodes/{id}
PATCH  /v1/nodes/{id}                peers, protocol params, periods
POST   /v1/nodes/{id}/start|stop|restart
DELETE /v1/nodes/{id}
GET    /v1/nodes/{id}/keys           key material export  ← see §3.1
GET    /v1/capabilities              hydra version + --hydra-script-catalogue

# user
ANY    /v1/nodes/{id}/api/*          proxied hydra-node HTTP
WS     /v1/nodes/{id}/api            proxied hydra-node WebSocket
GET    /v1/nodes/{id}/health         drift, sync, in-flight snapshot state
```

Proxy requirements that fall out of existing service behaviour: long-lived WS
carrying **full `?history=yes` event-log replay** (the evidence socket), plus
many short-lived probe sockets (the 25 s head-clock refresher). No response
buffering, no idle timeout below the replay duration.

### 2.3 Payment-service side

Minimal, model-respecting change: a host registry plus affinity on the existing
participant row.

```prisma
model HydraHost {
  id                  String   @id @default(cuid())
  name                String
  network             Network
  baseUrl             String            // https://hydra1.example.com
  adminTokenId        String?           // encrypted, admin ops only
  userTokenId         String            // encrypted, runtime
  publicPeerHost      String
  peerPortRangeStart  Int
  peerPortRangeEnd    Int
  hydraVersion        String?
  scriptCatalogueHash String?
  status              HydraHostStatus
  lastHealthAt        DateTime?
  Participants        HydraLocalParticipant[]
}
```

`HydraLocalParticipant` gains `hydraHostId` + `hostNodeId`; `nodeUrl` /
`nodeHttpUrl` become **derived** from `host.baseUrl + hostNodeId` rather than
hand-entered.

Head creation becomes: pick a host with free capacity on the network →
`POST /v1/nodes` → store returned `hydraVK`, `cardanoVkey`, advertise address →
exchange verification keys with the counterparty → `PATCH` peers on both sides
→ existing `init` / `commit` flow, unchanged.

Required plumbing: thread a bearer token through `HydraNodeConfig` →
`connection.ts` WS headers → `node.ts` HTTP calls, and derive URLs from the
host. Verify `capabilities` against the configured script hashes at provision
time and refuse a mismatch.

### 2.4 Horizontal scale

`HydraHost` rows are the scaling unit. Placement picks a host by
`network` + free capacity; the resulting head is **pinned** there for life
(§1.4). Draining a host means closing its heads, not migrating them.

Separately worth noting: `HydraConnectionManager` is a process-local singleton
with **no leader election** — every payment-service replica opens its own WS to
every enabled head. Behind a proxy that multiplies connections per replica.
Out of scope here, but it interacts with this work.

## 3. Resolved decisions

Settled in the grilling session; recorded in
[ADR 0015](../adr/0015-hydra-host-provisioning-and-exposure.md).

1. **Trust model** — Host and payment service are one security domain, with the
   Host treated as the more exposed side because it carries a public port.
2. **Key custody** — the Host generates both keys and discloses them **exactly
   once**, via two-phase provisioning: `POST /v1/nodes` with an idempotency key
   returns the material and holds the node in `pending-escrow`; the service
   persists it encrypted; `POST /v1/nodes/{id}/escrow-ack` starts the node and
   seals the disclosure path. Un-acked nodes are reaped. This revises
   `schema.prisma:1671-1677` — see the ADR.
3. **Peer plane** — published directly, one port per Head, plaintext etcd raft
   (no TLS exists upstream), protected by a **dynamic per-Head IP allowlist**.
   Peers configured by hostname so counterparty IP changes need no restart.
   `--listen`/`--advertise` stay independently configurable so a tunnel can be
   added later as pure configuration.
4. **Control plane** — single published port behind the authenticating proxy;
   TLS terminated by the platform load balancer, which also satisfies
   `node-url.ts`'s TLS requirement for non-loopback hosts.
5. **Token tiers** — admin: provision, escrow-ack, delete, reconfigure,
   capabilities. User: operate an existing node, whole proxied API and WS. No
   WS tag-gating, because lifecycle commands share the one long-lived socket
   with the event stream; residual risk is a close, not a fund loss.
6. **Capacity** — no operator-facing limit; ports are allocated durably per
   Head and **released on removal**. Production uses `--network host` so
   publishing imposes no limit; a published range is the dev fallback. One
   ceiling is inherent rather than chosen: the etcd client port is derived as
   `listenPort - 2622` with no override, so within a network namespace the peer
   range must satisfy `end - start < 2622` — at most 2621 concurrent nodes per
   Host. The allocator enforces this instead of hitting it as a bind failure.
   The peer port is immutable for a Head's life, because the etcd data dir is
   content-addressed by the cluster configuration and the advertise string is a
   participant identity (`msg-<advertise>` / `alive-<advertise>`).
7. **Ledger protocol parameters** — baked into the image, built from this repo
   so they stay pinned to the `packages/payment-source-v2` Mesh line, guarded
   in CI, and verified at provision time via a `/v1/capabilities` hash.
8. **Recovery** — every persisted node auto-starts on boot and reconnects.
   Restart is supervised with a drain (`/snapshot/last-seen`), never
   `--restart=always`. A Head is pinned to its Host; only volume destruction
   needs the escrowed keys plus a snapshot restore.
9. **Both parties on one Host** — supported but not required; nothing couples
   two nodes beyond distinct ports and persistence directories, which is how
   the current demo runs.

## 4. Delivery phases

Each phase is independently shippable and gets its own branch and PR.

1. **Host image + supervisor** — container with baked etcd
   (`--use-system-etcd`), durable node registry under `/data`, auto-start on
   boot, supervised drain/restart, drift watchdog. No payment-service change.
2. **Control-plane API** — token tiers, node CRUD, two-phase provisioning with
   escrow-ack, `/v1/capabilities`, allowlist management.
3. **Reverse proxy** — WS + HTTP passthrough to the right child node. Must
   tolerate long-lived `?history=yes` replay sockets and the frequent
   short-lived probe sockets the head-clock refresher opens.
4. **Payment-service auth** — credential field on `HydraNodeConfig`, headers
   through `connection.ts` and `node.ts`. Unblocks everything below.
5. **`HydraHost` model + placement** — migration, admin routes, derived node
   URLs, capabilities verification, head creation via the Host API.
6. **Cutover** — retire the `HYDRA_*` seed path for provisioned heads.

## 5. Still open

- **Multi-replica transport ownership.** `HydraConnectionManager` is a
  process-local singleton with no leader election, so every payment-service
  replica opens its own socket to every enabled Head. Behind a proxy this
  multiplies connections per replica. Pre-existing, but this work makes it
  more visible.
- **Counterparty onboarding.** Exchanging Hydra verification key, node Cardano
  key hash, advertised peer address, contestation period and ledger params
  with another operator is still manual. A cross-operator handshake API was
  raised and deliberately deferred as a separate feature.
