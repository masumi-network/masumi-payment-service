# Hydra Layer 2 Integration

## Overview

The Masumi Payment Service can route payment transactions to **Layer 2 (Hydra)** instead of **Layer 1 (Cardano)** when a Hydra head is active between two agents. This reduces fees and latency for high-frequency agent-to-agent transactions.

**Reference**: [Hydra Head Protocol](https://hydra.family/head-protocol/)

---

## Why Hydra

| | Cardano L1 | Hydra L2 |
|---|---|---|
| **Confirmation time** | ~20 seconds | ~1 second |
| **Transaction fee** | ~0.2–0.5 ADA | 0 ADA |
| **Throughput** | ~1 TPS (shared network) | 100+ TPS per head |

When two agents interact frequently (hire, submit result, refund, collect), L1 becomes slow and expensive. Hydra provides a dedicated, off-chain channel where these transactions settle instantly and without fees.

---

## Architecture Overview

```
┌────────────────────────────────────────────────────────────────────┐
│                     Masumi Payment Service                          │
│                                                                     │
│   User Request (hire, submit result, refund, collect, etc.)         │
│                              │                                      │
│                              ▼                                      │
│                 ┌─────────────────────────┐                         │
│                 │   Transaction Router    │                         │
│                 │                         │                         │
│                 │  1. Is Hydra enabled?   │                         │
│                 │  2. Is there an open    │                         │
│                 │     channel between     │                         │
│                 │     these 2 agents?     │                         │
│                 └────────────┬────────────┘                         │
│                              │                                      │
│                 ┌────────────┴─────────────┐                        │
│                 │                          │                        │
│            YES  ▼                     NO   ▼                        │
│   ┌──────────────────┐        ┌──────────────────┐                  │
│   │  Hydra Manager   │        │  Blockfrost /    │                  │
│   │  (@masumi-hydra) │        │  MeshSDK (L1)    │                  │
│   └────────┬─────────┘        └────────┬─────────┘                  │
│            │                           │                            │
└────────────┼───────────────────────────┼────────────────────────────┘
             │                           │
             ▼                           ▼
    ┌─────────────────┐        ┌─────────────────┐
    │   Hydra Node    │        │   Cardano L1    │
    │   ~1s, 0 ADA    │        │   ~20s, ~0.3 ADA│
    └─────────────────┘        └─────────────────┘
```

The Transaction Router sits between the payment handlers and the blockchain. Every transaction passes through it. The router checks the database for an active Hydra channel between the two agents involved, and routes accordingly.

---

## Hydra Head Lifecycle

A Hydra head goes through these states:

```
  Idle → Initializing → Open → Closed → FanoutPossible → Final
                          │
                          └──→ (transactions happen here)
```

| State | Description |
|-------|-------------|
| **Idle** | Head exists but no protocol activity yet |
| **Initializing** | Participants are committing funds from L1 into the head |
| **Open** | Head is active; transactions can be submitted and confirmed in ~1s |
| **Closed** | A participant has initiated closing; contestation period is active |
| **FanoutPossible** | Contestation period ended; final state can be fanned out to L1 |
| **Final** | Fanout complete; all funds are back on L1 |

The Transaction Router only routes to L2 when the head status is **Open**. All other states fall back to L1.

---

## Database Design

The Hydra integration uses three database models. They are independent of the existing `PaymentSource` model — Hydra routing is based purely on participant agent IDs.

### Entity Relationship

```
HydraChannel ──→ HydraHead ←── HydraParticipant
  (agentIdA)       (status)      (agentId, nodeUrl)
  (agentIdB)       (headId)      (keys, committed?)
```

### HydraHead

Represents a single Hydra head instance. Tracks the protocol state and lifecycle.

| Field | Purpose |
|-------|---------|
| `id` | Primary key (CUID) |
| `headId` | Hydra protocol head ID (assigned after Init; unique) |
| `network` | Cardano network (Preprod / Mainnet) |
| `status` | Current head state (nullable; null before initialization) |
| `contestationPeriod` | Seconds for the contestation window on close |
| `openedAt`, `closedAt`, `finalizedAt` | Lifecycle timestamps |
| `lastActivityAt` | For idle detection and auto-close logic |
| `lastSnapshotNumber` | Latest confirmed snapshot number |
| `lastError`, `lastErrorAt` | Error tracking |

**Indexes**: `[status]`, `[network, status]` — for fast lookup of open heads.

### HydraParticipant

Represents one participant in a Hydra head. Each participant runs their own Hydra node.

| Field | Purpose |
|-------|---------|
| `hydraHeadId` | FK to HydraHead |
| `agentId` | The participant's agent identifier (symmetric; not buyer/seller) |
| `participantIndex` | Order of the participant in the head (0-based) |
| `nodeUrl` | WebSocket URL for this participant's Hydra node |
| `nodeHttpUrl` | HTTP URL for this participant's Hydra node |
| `cardanoVerificationKey` | Cardano signing key for this participant |
| `hydraVerificationKey` | Hydra-specific signing key for this participant |
| `hasCommitted` | Whether this participant has committed funds to the head |

**Constraints**: Each agent can only appear once per head (`@@unique([hydraHeadId, agentId])`).

**Indexes**: `[agentId]`, `[agentId, hydraHeadId]` — for finding all heads an agent participates in.

### HydraChannel

A fast lookup table for the common 2-agent case. Maps a pair of agents to a Hydra head.

| Field | Purpose |
|-------|---------|
| `hydraHeadId` | FK to HydraHead |
| `agentIdA` | First agent (lexicographically smaller ID) |
| `agentIdB` | Second agent (lexicographically larger ID) |

**Why deterministic ordering?** When checking "is there a channel between Alice and Bob?", we always store Alice < Bob. This means the lookup is the same regardless of who initiates the transaction — no need to check both `(Alice, Bob)` and `(Bob, Alice)`.

**The same pair can have multiple channels.** For example, one head may be closing while a new one is opening. The router picks the most recent one with status `Open`.

**Indexes**: `[agentIdA, agentIdB]`, `[agentIdB, agentIdA]` — both orderings for fast lookups.

### Why Three Models?

- **HydraHead** stores the head itself (status, lifecycle, snapshots). It supports N participants, not just 2.
- **HydraParticipant** stores per-participant data (node URLs, keys). Each participant runs their own Hydra node with its own connection endpoint.
- **HydraChannel** is an optimization for the 2-agent lookup. Without it, finding "is there an open head between A and B?" requires a double join through `HydraParticipant`. With it, it's a single indexed query.

---

## Routing Decision Flow

When a payment handler submits a transaction, the Transaction Router evaluates these conditions **in order**:

```
1. Is forceLayer set?
   ├── YES → Use that layer (for testing / manual override)
   └── NO  → Continue

2. Is HYDRA_ENABLED=true?
   ├── NO  → Route to L1
   └── YES → Continue

3. Are both agent IDs available?
   ├── NO  → Route to L1 (can't look up a channel without both agents)
   └── YES → Continue

4. Query DB: Is there an open HydraChannel between these 2 agents?
   ├── NO  → Route to L1
   └── YES → Route to L2 (using the resolved head's connection info)
```

The decision is **per-transaction** — each call re-evaluates. This means if a head closes mid-session, subsequent transactions automatically fall back to L1.

### Channel Lookup

The router uses a configurable finder function (`setHydraHeadFinder`) that queries the database:

1. Sort the two agent IDs lexicographically (so the lookup is symmetric).
2. Query `HydraChannel` for a row matching `(agentIdA, agentIdB)`.
3. Join to `HydraHead` and check `status = Open`.
4. Join to `HydraParticipant` to get **our** node's connection URLs.
5. Return the head ID + node URLs, or null if no open channel exists.

The router then passes this resolved info to the Hydra Manager for actual submission.

---

## Transaction Submission

### L1 Path (Cardano)

```
Handler → Transaction Router → MeshSDK wallet.submitTx() → Blockfrost → Cardano
```

Standard Cardano L1 submission via Blockfrost. ~20s confirmation, standard fees. This is the existing behavior unchanged.

### L2 Path (Hydra)

```
Handler → Transaction Router → Hydra Manager → @masumi-hydra HydraHead.newTx() → Hydra Node
```

The Hydra Manager maintains a cache of `@masumi-hydra` HydraHead instances, keyed by the DB head ID. When the router resolves L2, the manager:

1. Gets or creates a HydraHead instance for this head ID.
2. Ensures the main node is connected.
3. Submits the signed transaction via `HydraHead.newTx()`.
4. The Hydra node validates the transaction against the head's ledger state.
5. If accepted (`TxValid`), returns the transaction hash.
6. If rejected (`TxInvalid`), returns the rejection reason.

### Uniform Result

Both paths return the same result shape to the handler: `{ txHash, layer, timestamp }`. The handler does not need to know which layer was used — it just gets a transaction hash to store in the database. The `layer` field is available for logging and analytics.

---

## UTXO Queries

When building transactions, handlers need UTXOs (unspent outputs). The router also routes UTXO queries:

- **L1**: Fetched from Blockfrost (`fetchAddressUTxOs`).
- **L2**: Fetched from the Hydra head snapshot via the `@masumi-hydra` HydraProvider.

The same routing decision applies: if there's an open channel between the agents, UTXOs come from L2; otherwise from L1.

---

## Transaction Types

All payment contract operations can be routed through the Transaction Router:

| Transaction Type | Description | Initiated By |
|------------------|-------------|-------------|
| LockFunds | Initial payment lock (hire agent) | Buyer |
| SubmitResult | Seller submits result hash | Seller |
| RequestRefund | Buyer requests a refund | Buyer |
| CancelRefund | Cancel a pending refund request | Buyer |
| AuthorizeRefund | Approve a refund (admin/seller) | Seller / Admin |
| CollectPayment | Collect completed payment | Seller |
| CollectRefund | Collect authorized refund | Buyer |

Each type passes through the same routing logic. The agent IDs (buyer and seller) are extracted from the transaction's `blockchainIdentifier` and treated as symmetric participants for the Hydra channel lookup.

---

## @masumi-hydra Package Integration

The `@masumi-hydra` package provides the `HydraHead` abstract class that manages:

- **Multiple participant nodes** — each with their own WebSocket connection.
- **L1 provider** (Blockfrost) and **L2 provider** (HydraProvider) for UTXO queries.
- **Head lifecycle** — init, commit, close, fanout.
- **Transaction submission** — `newTx()` sends a transaction and `awaitTx()` waits for confirmation.
- **Status tracking** — the head reports its current status (Idle, Initializing, Open, Closed, FanoutPossible, Final).

The Hydra Manager in the payment service wraps this package, creating and caching HydraHead instances per database head ID.

---

## Failover and Error Handling

### Automatic L1 Fallback

The routing decision is inherently safe: if no open channel exists, the transaction goes to L1. Channels are only returned when the head status is `Open` in the database.

### When L2 Fails at Submit Time

If the router chooses L2 but submission fails (node disconnected, head closed between check and submit, transaction rejected), the handler can catch the error and retry with `forceLayer: 'L1'`. This provides resilient submission without losing the transaction.

### Failure Scenarios

| Scenario | Impact | Action |
|----------|--------|--------|
| **One node down (2-party head)** | Head cannot progress; snapshots require all participants | Route to L1; optionally close the head |
| **Peer out of sync** | Snapshots stop being signed; head is stuck | Route to L1; coordinate snapshot recovery among peers |
| **Head stuck in Initializing** | Committed UTXOs too large for CollectCom | Abort the head; recover funds on L1 |
| **Head stuck in Open (>80 assets)** | Can close but FanOut may fail | Close the head; limit assets before closing |
| **Network / transport failures** | Flaky connections cause stalls | Route to L1; reconnect and retry |
| **Hydra node not connected** | Cannot submit to L2 | Route to L1 |
| **Contestation period after Close** | Head is not Open | Route to L1 until FanOut completes |

### Health Monitoring

The system should periodically check Hydra node connectivity and head status, updating the `HydraHead.status` field in the database. This ensures routing decisions stay accurate even if a head closes unexpectedly.

Key metrics to monitor:
- `hydra_head_peers_connected` — if 0, the head is effectively stuck.
- Head status transitions — update the DB when events are received.
- Last activity timestamp — for idle detection and auto-close.

### Mirror Nodes

For high availability, participants can run backup (mirror) nodes with the same keys. If a primary node fails, the mirror can continue signing. The constraint is that the mirror count `k` must satisfy `k < ⌊n/2⌋` to avoid etcd quorum issues.

See: [Run the Node on High Availability Using Mirror Nodes](https://hydra.family/head-protocol/docs/how-to/operating-hydra#run-the-node-on-high-availability-using-mirror-nodes)

---

## Configuration

| Environment Variable | Default | Purpose |
|---------------------|---------|---------|
| `HYDRA_ENABLED` | `false` | Master switch for L2 routing |
| `HYDRA_NODE_URL` | `ws://127.0.0.1:4001` | Default Hydra node WebSocket URL |
| `HYDRA_NODE_HTTP_URL` | `http://127.0.0.1:4001` | Default Hydra node HTTP URL |
| `HYDRA_DEBUG_LOGGING` | `false` | Log each routing decision with agent IDs and layer |

When `HYDRA_ENABLED` is `false`, no database lookups occur and all transactions go directly to L1.

---

## Summary

1. **Hydra heads are between participants**, not payment sources. Two agents can have a dedicated L2 channel regardless of which payment source they transact on.
2. **The database tracks head state** via three models: `HydraHead` (lifecycle), `HydraParticipant` (per-node connection info), and `HydraChannel` (fast 2-agent lookup).
3. **The Transaction Router** checks the database for an open channel on every transaction. If one exists, it routes to L2; otherwise L1.
4. **The Hydra Manager** wraps the `@masumi-hydra` package, managing HydraHead instances and delegating transaction submission.
5. **Failover is automatic**: no open channel = L1. Submit-time failures can be retried on L1.
6. **Both layers return the same result** (`txHash`, `layer`), so payment handlers don't need layer-specific logic.

---

## References

- [Hydra Head Protocol](https://hydra.family/head-protocol/)
- [Hydra GitHub](https://github.com/cardano-scaling/hydra)
- [Known Issues and Limitations](https://hydra.family/head-protocol/docs/known-issues)
- [Operate a Hydra Node](https://hydra.family/head-protocol/docs/how-to/operating-hydra)
- [ADR-32: Network Layer (etcd)](https://hydra.family/head-protocol/adr/32)
