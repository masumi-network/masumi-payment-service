# Hydra Host — implementation plan

Companion to [the architecture plan](./2026-07-28-hydra-host-production.md) and
[ADR 0015](../adr/0015-hydra-host-provisioning-and-exposure.md). That pair
records _what_ and _why_; this document is _how_.

Branch: `gd/hydra-node-ops`. Each phase below ships as its own branch and PR.

---

## Part A — the Hydra Host

### A1. Where it lives

A new workspace package, `packages/hydra-host/`, built from this repo so the
ledger protocol parameters stay pinned to the same Mesh line as
`packages/payment-source-v2` (§A8).

```
packages/hydra-host/
├── package.json
├── Dockerfile
├── src/
│   ├── index.ts               # boot: load registry, start supervisor + server
│   ├── config.ts              # env parsing, one place
│   ├── registry/              # durable node registry on /data
│   │   ├── store.ts           # read/write node.json, atomic rename
│   │   └── ports.ts           # durable allocation + release
│   ├── supervisor/
│   │   ├── supervisor.ts      # desired-state reconciler
│   │   ├── process.ts         # spawn/stop one hydra-node
│   │   ├── drain.ts           # /snapshot/last-seen gate
│   │   └── drift.ts           # Greetings currentSlot -> drift
│   ├── api/
│   │   ├── auth.ts            # admin vs user token
│   │   ├── nodes.ts           # lifecycle routes
│   │   ├── capabilities.ts
│   │   └── allowlist.ts
│   └── proxy/
│       ├── http.ts
│       └── ws.ts
└── params/                    # generated at build time, see A8
```

Per the repo's 750-line rule, `supervisor.ts` stays a reconciler only —
process spawning, draining and drift each live in their own file with their own
tests.

### A2. Image

Multi-stage, ending on `node:20-slim`:

1. Fetch the pinned `hydra-node` static binary (2.3.0, `linux/amd64` +
   `linux/arm64`), verified by checksum.
2. Fetch the matching `etcd` binary so we can run `--use-system-etcd`. This
   avoids hydra-node re-extracting etcd into the persistence volume on every
   boot, which would otherwise force the data volume to be writable **and**
   executable. **Open task:** determine which etcd version 2.3.0 embeds and
   pin exactly; if it cannot be matched, fall back to the embedded extractor
   and mount the volume `exec`.
3. Copy the control plane build output and the generated `params/`.

`ENTRYPOINT` is our control plane, **not** hydra-node — the container's job is
supervision, not being one node.

Build-time `ARG HYDRA_VERSION` flows into the image tag so the image is named
for the hydra-node it carries.

> `.dockerignore` currently does not exclude `hydra-l2-flow/`, which holds a
> live Blockfrost key and ~800 MB of binaries. Fix that before any image build.

### A3. Volume layout

```
/data/
├── host.json                 # host id, token hashes, port allocation map
└── nodes/<nodeId>/
    ├── node.json             # desired state + config (see A4)
    ├── keys/
    │   ├── hydra.sk  hydra.vk
    │   └── cardano.sk  cardano.vk
    ├── persistence/          # --persistence-dir
    └── logs/
```

Writes to `host.json` / `node.json` go through write-temp-then-rename so a
crash mid-write cannot corrupt the registry. Key files are `0600`; the
`cardano.sk` mode already matters today (`gen-preprod-keys.sh` sets `600`).

### A4. Node record and state machine

```ts
type NodeState =
	| 'PendingEscrow' // keys generated, NOT started, material still readable
	| 'Stopped' // escrowed; desired state stopped
	| 'Starting'
	| 'Running'
	| 'Draining' // waiting for a safe stop point
	| 'Failed' // supervisor gave up; needs operator
	| 'Removing';

type NodeRecord = {
	nodeId: string;
	state: NodeState;
	desired: 'Running' | 'Stopped';
	network: 'preprod' | 'mainnet';
	apiPort: number; // loopback only
	peerPort: number; // published; immutable for the head's life
	monitoringPort: number; // loopback only
	advertise: string; // <publicHost>:<peerPort>
	peers: string[]; // hostnames, not IPs
	hydraVkOfPeers: string[];
	cardanoVkeyOfPeers: string[];
	contestationPeriodSeconds: number;
	depositPeriodSeconds: number;
	unsyncedPeriodSeconds: number;
	escrowAckedAt: string | null;
	idempotencyKey: string;
	createdAt: string;
};
```

Transitions:

```
(provision) -> PendingEscrow
PendingEscrow --escrow-ack--> Stopped -> Starting -> Running
Running --stop/restart--> Draining -> Stopped
Running --crash--> Starting            (backoff)
any --delete--> Draining -> Removing -> gone (port released)
PendingEscrow --TTL expiry--> Removing (reaper)
```

`PendingEscrow` is the only state in which key material is readable, and only
by an admin token presenting the original idempotency key.

### A5. Supervisor

A reconciler loop: for every record, drive actual state toward `desired`.

**Boot.** Load the registry and start every node whose `desired` is `Running`.
This is the "on restart all heads need to connect again" requirement — it is
the supervisor's job, not Docker's.

**Spawn.** Ports come from the record, never from a counter in memory:

```
hydra-node
  --node-id <nodeId>
  --api-host 127.0.0.1  --api-port <apiPort>        # loopback: unreachable from outside
  --listen 0.0.0.0:<peerPort>
  --advertise <publicHost>:<peerPort>
  --peer <host>:<port> ...
  --monitoring-port <monitoringPort>
  --hydra-signing-key   keys/hydra.sk
  --hydra-verification-key <peer vk> ...
  --cardano-signing-key keys/cardano.sk
  --cardano-verification-key <peer vkey> ...
  --ledger-protocol-parameters /opt/hydra/params/<network>.json
  --network <network>
  --blockfrost /run/secrets/blockfrost.txt
  --persistence-dir persistence/
  --contestation-period <n>s --deposit-period <n>s --unsynced-period <n>s
  --use-system-etcd
```

Never `--persistence-rotate-after` — the service permanently fail-closes on
`EventLogRotated`.

**Stop is always drained.** `drain.ts` polls `GET /snapshot/last-seen` until the
tag is `LastSeenSnapshot` or `NoSeenSnapshot`, bounded by a timeout, then sends
SIGTERM and waits. A hard kill is a last resort and is recorded on the node
record, because it is the documented way to strand a head permanently.

**Crash restart** uses exponential backoff and trips to `Failed` after N
attempts rather than looping forever — a node that cannot start is usually a
config or chain problem that a restart will not fix.

**Drift watchdog** (`drift.ts`). Measured without touching log files: open a
short-lived WS with `?history=no`, read `Greetings.currentSlot`, convert slot →
wall time with the network's slot config, and take the delta. This is the same
technique already proven in
`hydra-connection-manager.service.ts` for the head clock. On
`drift > threshold`: drain, restart, wait for sync, alert. Thresholds default
to the launcher's current values (target 180 s, guard 400 s).

**Unwedge (automatic, levels 2–3).** Draining only covers _voluntary_ stops; an
OOM kill or host failure will strand a snapshot round eventually. After any
restart the supervisor checks for the stranded pattern — `/snapshot/last-seen`
stuck on an in-flight round while transactions fail `TxInvalid` — and recovers
by side-loading the node's **own last confirmed snapshot** via `POST /snapshot`.

This is a port of `hydra-l2-flow/run-hydra-e2e.sh:909-921`, which already does
exactly this (wait ~30 s, side-load, verify it un-wedged, fail loudly if not).
It needs no counterparty action. The same path covers a node that was offline
longer than etcd's compaction window (~1000 messages; widen with
`ETCD_AUTO_COMPACTION_*`).

Only if side-loading fails to un-wedge does the node move to `Failed`, so no
operator is involved in levels 0–3. Safety is preserved upstream of us: the
service refuses to treat `SnapshotSideLoaded` as a replay authentication anchor
(`docs/hydra-architecture.md:201`), so recovery cannot be used to inject
unverified state.

### A6. Ports

Three ports per node; only `peerPort` is ever published.

- `apiPort`, `monitoringPort` — loopback, freely reusable.
- `peerPort` — allocated once at provisioning from the configured range,
  recorded durably, **immutable for the head's life**, released only when the
  node is removed.

**Why `peerPort` is immutable.** hydra-node content-addresses the etcd data
directory by hashing the cluster configuration, so changing `--listen` /
`--advertise` / `--peer` does not migrate a cluster — it bootstraps a _fresh,
empty_ one. Two independent confirmations:

- Locally, the two parties of the running head have different data-dir hashes
  (`3b14f6d7…` vs `0a19ff2d…`), and `hydra.db`, `last-known-revision` and
  `pending-broadcast/` all live _outside_ that hashed directory — so they
  survive a config change and would then reference a cluster that no longer
  exists.
- Upstream, the broadcast key is literally `msg-<advertise host:port>` and
  liveness uses `alive-<advertise>`. The advertise value is a **participant
  identity**, not merely a address, so changing it changes who a node appears
  to be on the wire.

Changing a port is therefore a coordinated all-participant restart with
byte-consistent new values, not a runtime operation. The Host refuses
`peerPort` mutation via `PATCH`.

**Capacity ceiling — a real constraint.** The etcd client port is derived as
`2379 + listenPort - 5001`, i.e. `listenPort - 2622`, is loopback-bound, and
has no CLI override. Within one network namespace the derived client range
must not overlap the listen range:

```
listen  [S, E]  ->  client [S-2622, E-2622]
no overlap  <=>  E - 2622 < S  <=>  (E - S) < 2622
```

So a single network namespace supports at most **2621 concurrent nodes**, and
the peer range must satisfy `end - start < 2622`. With `start = 5001` the range
may run to 7622. Beyond that, a node's derived client port would collide with
another node's peer port. This is far above practical need, but it is a hard
ceiling and the allocator must enforce it rather than discover it as a bind
failure.

Production runs `--network host` so port _publication_ imposes no limit; a
published range (`-p 5001-5032:5001-5032`) is the dev fallback and is then the
binding limit. Allocation is dynamic within the range and freed ports are
reused after removal.

**Advertise consistency.** Because etcd validates a member's
`--initial-advertise-peer-urls` against its `--initial-cluster` entry at
bootstrap, and Hydra's self-filtering compares strings exactly, both
participants must configure the _same externally reachable_ URL for a given
node. The Host therefore returns its `advertise` string at provisioning and
that exact string is what the counterparty must be given — not a
reconstructed one.

### A7. Control-plane API

`Authorization: Bearer <token>`. Tokens are compared against salted hashes in
`host.json`, in constant time.

| Method  | Path                                  | Tier  | Notes                                                                                                                                    |
| ------- | ------------------------------------- | ----- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| POST    | `/v1/nodes`                           | admin | `Idempotency-Key` required. Generates keys, allocates ports, writes record as `PendingEscrow`. **Does not start.** Returns key material. |
| POST    | `/v1/nodes/{id}/escrow-ack`           | admin | Seals disclosure, sets `desired=Running`, starts.                                                                                        |
| GET     | `/v1/nodes`                           | admin | Records without key material.                                                                                                            |
| GET     | `/v1/nodes/{id}`                      | admin |                                                                                                                                          |
| PATCH   | `/v1/nodes/{id}`                      | admin | Peers, periods. Rejects `peerPort` changes. Requires stopped.                                                                            |
| POST    | `/v1/nodes/{id}/start\|stop\|restart` | admin | Always drained.                                                                                                                          |
| DELETE  | `/v1/nodes/{id}`                      | admin | Drain → remove → release port. Refuses unless the head is `Final` or `force`.                                                            |
| GET     | `/v1/nodes/{id}/health`               | user  | State, drift, sync, last-seen-snapshot, restart count.                                                                                   |
| GET     | `/v1/capabilities`                    | admin | hydra version, `--hydra-script-catalogue`, params hash, free port count.                                                                 |
| GET/PUT | `/v1/nodes/{id}/allowlist`            | admin | Per-head peer allowlist; dynamic.                                                                                                        |
| ANY     | `/v1/nodes/{id}/api/*`                | user  | Proxied hydra-node HTTP.                                                                                                                 |
| WS      | `/v1/nodes/{id}/api`                  | user  | Proxied hydra-node WebSocket.                                                                                                            |

Provision request/response sketch:

```jsonc
// POST /v1/nodes   (Idempotency-Key: <cuid>)
{ "network": "preprod", "contestationPeriodSeconds": 220,
  "depositPeriodSeconds": 300, "unsyncedPeriodSeconds": 1800 }

// 201
{ "nodeId": "...", "state": "PendingEscrow",
  "hydraVk": "5820...", "cardanoVkey": "<28-byte hex>",
  "advertise": "hydra1.example.com:5007", "peerPort": 5007,
  "secrets": { "hydraSk": "5820...", "cardanoSk": "..." } }  // only ever here
```

Peers are set by `PATCH` once the counterparty's material is known, because at
provisioning time we do not yet have it.

### A8. Ledger protocol parameters

Generated at build time into `params/<network>.json` from the Mesh version
pinned by `packages/payment-source-v2` — the same coupling
`hydra-l2-flow/align-cost-models.cjs` and
`packages/payment-source-v2/src/utils/mesh-cost-model-sync.ts` handle today. A
CI check regenerates and diffs, failing on drift. `/v1/capabilities` reports a
hash so the payment service can refuse to provision against a skewed host.

### A9. Proxy

Requirements come from how the service actually uses the socket:

- **WebSocket passthrough**, including `?history=yes` full event-log replay.
  No response buffering, no idle timeout shorter than a replay.
- **Many short-lived sockets** — the head-clock refresher opens one every 25 s.
- Strip any client-supplied `Authorization` before forwarding; hydra-node
  ignores it, but it must not be reflected onward.
- Never proxy to a node that is not `Running`; return `409`.

### A10. Configuration

```
HYDRA_HOST_PUBLIC_HOST          # feeds --advertise
HYDRA_HOST_ADMIN_TOKEN          # hashed into host.json on first boot
HYDRA_HOST_USER_TOKEN
HYDRA_HOST_PORT                 # control plane, default 8443
HYDRA_HOST_PEER_PORT_START/COUNT
HYDRA_HOST_NETWORK
BLOCKFROST_PROJECT_FILE         # mounted secret, not an env value
HYDRA_HOST_DRIFT_TARGET/GUARD
HYDRA_HOST_ESCROW_TTL_SECONDS
```

TLS terminates outside the container; it serves plain HTTP and honours
`X-Forwarded-Proto`. See §A11.

### A11. Deployment target

**DigitalOcean App Platform cannot host nodes.** Persistence is a SQLite event
store plus an etcd raft WAL needing real fsync durability on local disk, and
App Platform has an ephemeral filesystem with no persistent volumes.
Checkpointing to Spaces does not save it: an involuntary kill between
checkpoints loses head state, which is the one unrecoverable failure.

Target: a droplet with a Block Storage volume mounted at `/data`.

```bash
docker run -d --name hydra-host \
  --network host \
  -v /mnt/hydra_data:/data \
  --stop-timeout 300 \
  -e HYDRA_HOST_PUBLIC_HOST=hydra1.example.com \
  -e HYDRA_HOST_ADMIN_TOKEN=... -e HYDRA_HOST_USER_TOKEN=... \
  masumi/hydra-host:2.3.0
```

- `--network host` removes the port-publication ceiling (§A6).
- `--stop-timeout 300` gives the supervisor a real drain window; Docker's
  10 s default would SIGKILL mid-drain.
- **No `--restart=always`** — restart policy belongs to the supervisor, which
  drains first (§A5).

Exposure on the droplet: the control-plane port is reached through a managed
load balancer that terminates TLS; peer ports are exposed directly on the
droplet IP under a cloud-firewall allowlist, because per-head dynamic TCP ports
behind a managed LB are unworkable and the peer plane has no TLS upstream
anyway. Volume snapshots cover level-4 recovery.

**Orchestrator-agnostic image contract** — so DOKS later is a deployment change,
not a rewrite:

1. Every durable byte lives under one mount point (`/data`).
2. SIGTERM drains all nodes, then exits; the process never assumes it will be
   asked twice.
3. No assumptions about the host — no fixed hostname, no host paths outside the
   mount, public identity supplied only via `HYDRA_HOST_PUBLIC_HOST`.
4. TLS, certificates and ACME state stay outside the image entirely.

Under DOKS this becomes a StatefulSet with `volumeClaimTemplates` and
`terminationGracePeriodSeconds: 300`; head-to-host affinity is then carried by
the PVC binding.

---

## Part B — payment-service changes

### B1. Authenticated node connections (prerequisite for everything else)

- `src/lib/hydra/hydra/types.ts:128-137` — add optional `authToken` to
  `HydraNodeConfig`.
- `src/lib/hydra/hydra/connection.ts:45-48` — pass `headers` to the
  `WebSocket` constructor.
- `src/lib/hydra/hydra/node.ts:1575` and
  `hydra-connection-manager.service.ts:661` — send `Authorization` on HTTP.
- `src/services/hydra-connection-manager/hydra-connection-manager.service.ts:504`
  — the head-clock probe socket needs the header too.
- `node-url.ts:85-87` keeps rejecting userinfo in URLs; the token travels as a
  header, never in the URL.

### B2. Schema

```prisma
model HydraHost {
  id                  String   @id @default(cuid())
  name                String
  network             Network
  baseUrl             String
  publicPeerHost      String
  encryptedAdminToken String?
  encryptedUserToken  String
  hydraVersion        String?
  scriptCatalogueHash String?
  ledgerParamsHash    String?
  status              HydraHostStatus
  lastHealthAt        DateTime?
  Participants        HydraLocalParticipant[]
  @@unique([network, baseUrl])
}
```

`HydraLocalParticipant` gains `hydraHostId` + `hostNodeId`; `nodeUrl` /
`nodeHttpUrl` become derived and stop being operator-entered.

Tokens are encrypted with `@/utils/security/encryption`, matching how
`hydraSK` is handled today.

### B3. Routes

`/hydra/host` GET/POST/PATCH/DELETE (admin), plus
`POST /hydra/host/{id}/provision-node` which performs provision → persist
secrets → escrow-ack as one operation, so a partially-provisioned node cannot
be left behind. OpenAPI goes in `src/routes/api/hydra/docs.ts` alongside the
rest; CI fails on drift.

### B4. Head creation

`createBoundHydraHead` (`head/index.ts:468`) is extended so that when the
relation's local participant has no node yet, it provisions one on a selected
host and stores the returned `hydraVk` / `cardanoVkey` / advertise address.
The existing on-chain verification path is untouched — it still validates the
head datum against the two-party key set and contestation period.

Placement: first host matching `network` with capacity and a healthy last
check; pinned thereafter.

### B5. Capabilities check

Before provisioning, compare `/v1/capabilities` against the configured
`HYDRA_DEPOSIT_SCRIPT_HASH` / `HYDRA_HEAD_SCRIPT_HASH` and the expected ledger
params hash. Mismatch refuses provisioning rather than producing a head that
fails at commit time.

---

## Part D — cross-org head handshake

### D1. Why this is required, not optional

A node lives for exactly one Head (decided 2026-07-28), so every Head needs
fresh keys, a fresh peer port and a fresh etcd cluster config. Three startup
facts make the exchange a hard precondition:

- `--peer` and `--hydra-verification-key` are **startup flags**, not runtime
  state.
- `--initial-cluster` is derived from own advertise plus all peers, and the
  etcd data dir is content-addressed by it, so both sides must agree before
  first boot.
- A two-party head needs quorum `⌊n/2⌋+1 = 2`, so a lone node makes no
  progress; it waits for its peer.

The two sides need not act simultaneously — only to agree config before either
starts. `PendingEscrow` / `Stopped` is that staging area. But because this
recurs per Head, manual exchange does not scale and the handshake must be an
API.

### D2. Trust anchor — reuse the existing signed-payload pattern

The offer is signed by the offering side's Relation wallet key and verified by
the receiver with `checkSignature` against
`HydraRelation.RemoteWallet.walletVkey` — exactly the mechanism already used to
authenticate a seller's `blockchainIdentifier` to a buyer
(`src/utils/generator/blockchain-identifier-payload.ts`, verified at
`src/routes/api/purchases/shared.ts:233`).

This means **no new credential distribution**: the two parties already agreed
on each other's wallets when the Relation was created. A stranger cannot open a
Head with us, because their offer will not verify against a Relation we hold.

Only **public** material crosses the org boundary — verification keys and an
advertise address. No signing key ever leaves its Host.

### D3. Schema

`HydraRelation` gains `counterpartyBaseUrl` (long-lived, set once at Relation
setup — it does not exist today).

```prisma
model HydraHeadOffer {
  id                     String   @id @default(cuid())
  hydraRelationId        String
  headSequence           Int          // binds an offer to one Head slot
  nonce                  String   @unique
  role                   HydraOfferRole   // Offerer | Acceptor
  status                 HydraOfferStatus // Proposed|Accepted|Configured|Started|Declined|Expired
  expiresAt              DateTime
  ownNodeId              String
  offeredHydraVk         String
  offeredCardanoVkey     String
  offeredAdvertise       String
  counterpartyHydraVk    String?
  counterpartyCardanoVkey String?
  counterpartyAdvertise  String?
  contestationPeriodSeconds Int
  depositPeriodSeconds      Int
  ledgerParamsHash       String
  @@unique([hydraRelationId, headSequence])
}
```

### D4. Endpoints

Inbound, cross-org — authenticated by **signature, not by API key**, and rate
limited:

| Method | Path                              | Caller                 |
| ------ | --------------------------------- | ---------------------- |
| POST   | `/api/v1/hydra/handshake/offer`   | counterparty's service |
| POST   | `/api/v1/hydra/handshake/accept`  | counterparty's service |
| POST   | `/api/v1/hydra/handshake/decline` | counterparty's service |

Operator-facing (admin): `POST /hydra/head/propose` starts the flow for a
Relation.

### D5. Initiator tie-break

Both sides see themselves as "local", so nothing inherently designates an
initiator and both could propose the same Head slot at once. Rule: **the party
whose Relation wallet vkey sorts lexicographically lower is the initiator.**
A node receiving an offer from the higher-sorting party for a slot it has
already proposed declines it, collapsing the race deterministically.

### D6. Flow

```
A (initiator)                                B (counterparty)
1 provision -> PendingEscrow -> escrow-ack -> Stopped   (not started)
2 ---- OFFER {hydraVK_A, cardanoVkey_A, advertise_A, periods,
              ledgerParamsHash, relationId, headSequence, nonce, expiry}
       signed by A's relation wallet ------------------->
                                             3 verify sig vs relation
                                               provision own node
4 <--- ACCEPT {hydraVK_B, cardanoVkey_B, advertise_B} signed by B ----
5 PATCH peers+vkeys, allowlist            5' PATCH peers+vkeys, allowlist
6 start                                   6' start
                  └─ etcd cluster forms (needs both) ─┘
7 Init on-chain -> Initializing -> commits -> Open   (existing flow, unchanged)
```

`ledgerParamsHash` travels in the offer so a mismatch is rejected at handshake
time rather than surfacing later as `PPViewHashesDontMatch` on the first
in-head script spend.

### D7. Safety properties

- **Replay** — the signature covers `relationId`, `headSequence`, `nonce` and
  `expiry`, so an old offer cannot be replayed to open an unwanted Head.
- **Idempotency** — the nonce is the idempotency key, so a lost ACCEPT
  response does not provision a second node on retry.
- **Abandonment** — an offer not reaching `Started` before `expiresAt` is
  reaped on both sides: nodes deleted, ports released. This shares the
  `PendingEscrow` TTL reaper.
- **Declines** — an explicit decline releases the offerer's node immediately
  rather than waiting for expiry.

### D8. Consequences of per-Head nodes

- A peer port is consumed per Head and released at `Final`; with sequential
  Heads per Relation, churn is bounded.
- Each Head gets its own persistence directory, which never rotates. A
  retention policy is needed: archive or delete a Head's directory only after
  it is `Final` **and** its settlement has been independently verified.
- Every Head performs one cross-org round trip before it can start, so Head
  opening is no longer a purely local operation and must tolerate the
  counterparty being slow or unreachable.

## Part C — delivery

| Phase | Scope                                                                     | Depends on   |
| ----- | ------------------------------------------------------------------------- | ------------ |
| 1     | Package skeleton, image, registry, supervisor (spawn/drain/restart/drift) | —            |
| 2     | Control-plane API + auth + two-phase provisioning + allowlist             | 1            |
| 3     | Reverse proxy (HTTP + WS passthrough)                                     | 1            |
| 4     | Payment-service auth plumbing (B1)                                        | — (parallel) |
| 5     | `HydraHost` model, routes, placement, capabilities check                  | 2,3,4        |
| 6     | Cross-org handshake (Part D): offer/accept/decline, tie-break, reaper     | 5            |
| 7     | Head creation via host API; retire `HYDRA_*` seeding for new heads        | 6            |

### Testing

- **Unit** — port allocation/release, registry atomicity, state machine
  transitions, drift maths, drain predicate, token comparison.
- **Integration** — a real hydra-node in offline mode
  (`--offline-head-seed`) exercises provision → start → proxy → stop without
  touching a chain.
- **Two-node** — the existing `hydra-l2-flow` harness repointed at two hosts,
  proving a head opens through provisioned nodes.
- **Negative** — API unreachable from outside the container; proxy refuses a
  non-running node; provisioning refused on capability mismatch; restart
  without drain is never issued.

### Security invariants (review checklist)

1. `--api-host` is `127.0.0.1` on every spawn; no code path sets otherwise.
2. The only published port is a `peerPort`.
3. Key material is returned only in `PendingEscrow`, only to admin, only with
   the matching idempotency key.
4. Tokens are compared in constant time and never logged.
5. `GET /config` on hydra-node is **not** proxied — it discloses key paths.
6. `--persistence-rotate-after` is never passed.
7. No hard kill without a recorded drain attempt.

### Open risks

- **etcd version match** for `--use-system-etcd` (§A2).
- **Peer traffic is cleartext** — accepted, revisitable as config.
- **Multi-replica transport ownership** — every payment-service replica opens
  its own socket to every head; a proxy multiplies this.
- **Counterparty onboarding** is still manual.
- **Blockfrost as a chain backend** is the less-hardened upstream path and is
  the source of the drift problem the supervisor exists to paper over.
