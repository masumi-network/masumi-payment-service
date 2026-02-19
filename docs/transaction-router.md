# Transaction Router

This document describes how the Transaction Router handles user requests and routes them to either Cardano Layer 1 or Hydra Layer 2.

---

## Purpose

Every payment transaction in the Masumi Payment Service — locking funds, submitting results, requesting refunds, collecting payments — needs to be submitted to the blockchain. The Transaction Router is the single point that decides **which blockchain layer** to use and handles submission for both.

Without the router, every handler would submit directly to Cardano L1 via Blockfrost. The router sits in between, transparently redirecting to Hydra L2 when an open head exists between the participants.

---

## Where the Router Sits

```
API / Background Job
        │
        ▼
  Payment Handler          (builds and signs the transaction)
        │
        ▼
  Submit Helper            (adds routing context: participant IDs, tx type)
        │
        ▼
  Transaction Router       (decides L1 or L2, submits accordingly)
        │
   ┌────┴────┐
   ▼         ▼
 Hydra    Cardano L1
 (L2)     (Blockfrost)
```

The handler does not know or care which layer is used. It receives back a transaction hash and the layer that was used, then updates the database.

---

## Request Entry Points

All payment operations flow through the router:

| User Action | Trigger | Transaction Type |
|-------------|---------|------------------|
| Hire an agent (lock funds) | API request or background batch job | LockFunds |
| Submit result | Background job | SubmitResult |
| Request refund | Background job | RequestRefund |
| Cancel refund | Background job | CancelRefund |
| Authorize refund | Background job | AuthorizeRefund |
| Collect payment | Automatic background job | CollectPayment |
| Collect refund | Automatic background job | CollectRefund |

---

## Flow: From User Request to Blockchain

### 1. Handler Builds and Signs

The payment handler (e.g., the payment batcher for LockFunds) loads data from the database, constructs the unsigned Cardano transaction (inputs, outputs, datum, redeemer), and signs it with the wallet.

### 2. Submit Helper Adds Context

The handler passes the signed transaction to a submit helper function. The helper adds **routing context** — the two participant IDs involved, the transaction type, the payment source, and the network. This context is what the router needs to make its decision.

The participant IDs come from the `blockchainIdentifier` stored on each purchase or payment request. They identify the buyer and seller, but for routing purposes they are treated as symmetric participants (either one could be "participant A" or "participant B"). Participants can be agents or external buyers (marketplace frontend users).

### 3. Router Decides the Layer

The Transaction Router evaluates a series of conditions to determine L1 or L2:

**Step 1 — Force override.** If `forceLayer` is set in the context (e.g., for testing), use that layer immediately.

**Step 2 — Global switch.** If `HYDRA_ENABLED` is false, route to L1. No database queries are made.

**Step 3 — Head lookup.** If both participant IDs are available, query the database for an open Hydra head between these two participants. This lookup uses `HydraRelation` (the persistent relation table, indexed by `participantIdA` and `participantIdB` in deterministic order) to find a `HydraHead` with status `Open`. If found, the query also resolves the connection URL for our participant's Hydra node.

**Step 4 — Fallback.** If no open head is found, route to L1.

### 4. Router Submits the Transaction

**If L2 (Hydra):**
The router passes the signed transaction to the Hydra Manager, which maintains cached `@masumi-hydra` HydraHead instances. The manager connects to the resolved participant's Hydra node and submits the transaction via the Hydra protocol (`NewTx` command over WebSocket). The Hydra node validates the transaction against the head's current ledger state and either accepts (`TxValid`) or rejects (`TxInvalid`) it.

**If L1 (Cardano):**
The router calls `wallet.submitTx()` through MeshSDK, which sends the transaction to Blockfrost, which broadcasts it to the Cardano network.

### 5. Handler Receives the Result

Both paths return the same result shape: a transaction hash, the layer used, and a timestamp. The handler stores the transaction hash in the database and does not need layer-specific logic.

---

## Layer Determination — Decision Table

| # | Condition | Result |
|---|-----------|--------|
| 1 | `forceLayer` is set | Use that layer |
| 2 | `HYDRA_ENABLED` is false | L1 |
| 3 | Both participant IDs present AND open HydraHead found in DB | L2 |
| 4 | Otherwise | L1 |

The decision is made **per-transaction**. If a Hydra head closes between two consecutive transactions, the second one automatically falls back to L1.

---

## Head Lookup in Detail

The router's head lookup follows this process:

1. **Sort participant IDs.** The two participant IDs are sorted lexicographically. This ensures the lookup is symmetric — regardless of which participant is the buyer or seller, the query is the same.

2. **Query HydraRelation.** Look up the `HydraRelation` table by `(network, participantIdA, participantIdB)`. This is a direct indexed unique query.

3. **Find open head.** From the `HydraRelation`, query its related `HydraHead` records for one with `status = Open`. A relation can have many heads over time, but typically only one is open.

4. **Resolve connection info.** From the open `HydraHead`, look up `HydraParticipant` to find **our** participant's node URL. Each participant runs their own Hydra node, and we need to connect to ours.

5. **Return or fall back.** If an open head with valid connection info is found, return it. Otherwise return null, and the router falls back to L1.

---

## Data Model

```
HydraRelation (participantIdA, participantIdB, network)   ← persistent relation / lookup key
  └── HydraHead[]                                       ← individual head sessions (1:N)
       ├── HydraParticipant[] (node URLs, keys, type)
       ├── HydraSnapshot[]
       └── Transaction[]
```

- **HydraRelation**: The persistent relation between two participants on a specific network. One record per unique participant pair per network.
- **HydraHead**: A single head session. Goes through `Idle → Open → Closed → Final`. A relation can have many heads over its lifetime.
- **HydraParticipant**: Per-head participant config (node URLs, verification keys, encrypted secret keys via `HydraSecret`).
- **HydraSnapshot**: Confirmed snapshots within a head, used for L2→L1 reconciliation after fanout.

---

## UTXO Queries

Transaction building requires UTXOs (unspent outputs). The router also routes UTXO queries:

- **L1**: Fetched from Blockfrost.
- **L2**: Fetched from the Hydra head's snapshot via the `@masumi-hydra` HydraProvider.

The same routing decision applies. If there's an open head, UTXOs come from the Hydra snapshot; otherwise from Blockfrost. This ensures transactions are built against the correct ledger state for the layer they'll be submitted to.

---

## Error Handling

### L2 Submission Failures

| Scenario | What Happens |
|----------|-------------|
| Hydra node not connected | Error thrown; handler can retry on L1 |
| Head not in Open state | Error thrown; handler can retry on L1 |
| Hydra rejects the transaction | Error with rejection reason; do not retry same tx |
| Network timeout | Error thrown; handler can retry on L1 |

### L1 Fallback Strategy

The router itself does **not** automatically retry on L1 when L2 fails. This is by design — the handler knows the business context and can decide whether an L1 retry is appropriate. Handlers can catch the error and resubmit with `forceLayer: 'L1'`.

### Missing Participant IDs

If one or both participant IDs are missing from the routing context, the head lookup is skipped entirely and the transaction goes to L1. This is safe — it just means no Hydra optimization for that particular transaction.

---

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `HYDRA_ENABLED` | `false` | Master switch. When false, no DB lookups occur; everything goes to L1. |
| `HYDRA_DEBUG_LOGGING` | `false` | When true, logs every routing decision with participant IDs, layer chosen, and transaction type. |

The router is initialized as a singleton on first use. It can also be initialized explicitly with custom configuration.

---

## Sequence: L2 Submission

```
User/API → Handler → Submit Helper → Router → Hydra Manager → Hydra Node
                                       │
                                       ├─ 1. resolveRouting(context)
                                       │     → query HydraRelation → HydraHead (Open)
                                       │     → found open head
                                       │
                                       ├─ 2. submitToL2(signedTx, headInfo)
                                       │     → get/create HydraHead instance
                                       │     → HydraHead.newTx(transaction)
                                       │
                                       └─ 3. return { txHash, layer: 'L2' }
```

## Sequence: L1 Submission

```
User/API → Handler → Submit Helper → Router → wallet.submitTx() → Blockfrost → Cardano
                                       │
                                       ├─ 1. resolveRouting(context)
                                       │     → HYDRA_ENABLED=false, or
                                       │     → no open head found
                                       │
                                       ├─ 2. submitToL1(signedTx, wallet)
                                       │     → wallet.submitTx(signedTx)
                                       │
                                       └─ 3. return { txHash, layer: 'L1' }
```

---

## Key Design Decisions

### Why a single router instead of per-handler logic?

Centralizing the L1/L2 decision in one place means handlers don't need to be modified when Hydra support changes. Adding a new transaction type only requires calling the appropriate submit helper — the routing logic is inherited.

### Why is the head lookup a configurable function?

The router accepts a `setHydraHeadFinder()` function rather than querying the database directly. This keeps the router independent of Prisma and makes it testable — tests can inject a mock finder without a real database.

### Why treat participant IDs as symmetric?

In the Masumi payment system, there is a buyer and a seller. But for Hydra, a head is between participants — either side can initiate any transaction type. Today's buyer may be tomorrow's seller. Storing and querying participant pairs in deterministic order eliminates duplicate lookups and simplifies the data model.

### Why not auto-fallback to L1?

The router throws on L2 failure rather than silently falling back. This is intentional: the handler has business context (is this a critical payment? has the tx already been submitted?) that the router lacks. Silent fallback could lead to duplicate submissions or inconsistent state.

---

## File Locations

| Component | Location |
|-----------|----------|
| Transaction Router | `src/services/transaction-router/transaction-router.service.ts` |
| Submit Helpers | `src/services/transaction-router/submit-helpers.ts` |
| Routing Types | `src/services/transaction-router/types.ts` |
| Hydra Manager | `src/services/hydra/hydra-manager.ts` |
| Hydra Sync Service | `src/services/hydra/hydra-sync.service.ts` |
| Hydra Types | `src/services/hydra/types.ts` |
| Database Schema | `prisma/schema.prisma` (HydraRelation, HydraHead, HydraParticipant, HydraSecret, HydraSnapshot) |
| Configuration | `src/utils/config/index.ts` (HYDRA_CONFIG) |
