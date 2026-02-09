# Hydra Layer 2 Integration

## Overview

The Masumi Payment Service can route payment transactions to **Layer 2 (Hydra)** instead of **Layer 1 (Cardano)** when a Hydra head is active between two agents. This reduces fees and latency for high-frequency agent-to-agent transactions.

**Reference**: [Hydra Head Protocol](https://hydra.family/head-protocol/)

## Problem

- **L1**: ~20s confirmation, ~0.2–0.5 ADA per tx, ~1 TPS
- **L2 (Hydra)**: ~1s confirmation, 0 ADA fees, 100+ TPS per head

When two agents have many transactions (hire, submit result, refund, collect), L1 becomes slow and expensive.

## Solution: Route to Hydra When Active

```
┌─────────────────────────────────────────────────────────────────┐
│                    Masumi Payment Service                        │
│                                                                  │
│  User Request (hire, submit result, refund, collect, etc.)       │
│                           │                                      │
│                           ▼                                      │
│              ┌────────────────────────────┐                      │
│              │     Transaction Router     │                      │
│              │                            │                      │
│              │  Is Hydra active between   │                      │
│              │  these 2 agents?           │                      │
│              └────────────┬───────────────┘                      │
│                           │                                      │
│              ┌────────────┴────────────┐                         │
│              │                         │                         │
│         YES  ▼                    NO   ▼                         │
│  ┌─────────────────┐         ┌─────────────────┐                │
│  │ Hydra Client    │         │ Blockfrost       │                │
│  │ (WebSocket)     │         │ (L1)             │                │
│  └────────┬────────┘         └────────┬────────┘                │
│           │                            │                         │
└───────────┼────────────────────────────┼─────────────────────────┘
            │                            │
            ▼                            ▼
   ┌─────────────────┐         ┌─────────────────┐
   │  Hydra Node      │         │  Cardano L1      │
   │  (L2) ~1s, 0 ADA │         │  ~20s, ~0.3 ADA │
   └─────────────────┘         └─────────────────┘
```

## Hydra Head Lifecycle (Simplified)

1. **Open** – Participants commit funds to the head (on L1).
2. **Transact** – All payment operations (lock, submit result, refund, collect) run on L2.
3. **Close** – Head closes; final state is fanned out to L1.

When the head is **Open**, the Transaction Router sends transactions to the Hydra node instead of Cardano L1.

## Implementation

### Transaction Router

**Location**: `src/services/transaction-router/`

- **`transaction-router.service.ts`** – Decides L1 vs L2 and submits accordingly.
- **`submit-helpers.ts`** – Helpers for each transaction type (lock funds, submit result, request refund, etc.).
- **`types.ts`** – Routing context and result types.

**Detailed flow**: See [Transaction Router: Detailed Flow Documentation](transaction-router.md) for step-by-step handling of user requests and routing to the Hydra node.

### Hydra Service

**Location**: `src/services/hydra/`

- **`types.ts`** – Types aligned with the `@masumi-hydra` package (`HydraHeadStatus`, `HydraHeadConfig`, `ActiveHydraHeadInfo`, etc.).
- **`hydra-manager.ts`** – Manages `@masumi-hydra` HydraHead instances, keyed by DB HydraHead ID. Provides `submitTransactionToHydra()` and `fetchUtxosFromHydra()`.
- **`index.ts`** – Public exports.

The hydra-manager wraps the `@masumi-hydra` package's `HydraHead` class (abstract base for Hydra head protocol interaction). Each HydraHead instance manages multiple participant nodes, L1/L2 providers, and transaction submission.

```typescript
// When integrating @masumi-hydra:
import { HydraHead } from '@masumi-hydra/head';

const head = new HydraHead(config);
await head.connectMainNode();
const txHash = await head.newTx(transaction);
await head.awaitTx(txHash);
```

### Routing Logic

The router uses a configurable **finder** to locate an active Hydra head between two agents.
Agent IDs are symmetric (no buyer/seller distinction); the Hydra head is between **participants**:

```typescript
// Option 1: DB-backed finder (recommended)
// Uses HydraChannel for fast 2-agent lookup, then picks our node URLs
// from the HydraParticipant table. Agents are stored in deterministic order
// (smaller agentId first) so lookups are symmetric.
router.setHydraHeadFinder(async (agentIdA, agentIdB) => {
  const [sortedA, sortedB] = agentIdA < agentIdB
    ? [agentIdA, agentIdB]
    : [agentIdB, agentIdA];

  const channel = await prisma.hydraChannel.findFirst({
    where: { agentIdA: sortedA, agentIdB: sortedB },
    include: {
      HydraHead: {
        include: { Participants: true },
      },
    },
    orderBy: { createdAt: 'desc' },
  });

  if (!channel || channel.HydraHead.status !== 'Open') return null;

  // Pick the participant whose node we should connect to (our own node)
  const ourParticipant = channel.HydraHead.Participants.find(
    p => p.agentId === ourAgentId,
  );
  if (!ourParticipant) return null;

  return {
    id: channel.HydraHead.id,
    nodeUrl: ourParticipant.nodeUrl,
    nodeHttpUrl: ourParticipant.nodeHttpUrl,
  };
});

// Option 2: Default – use L2 when a globally configured Hydra client is connected
// and head is Open (simple setup, no DB lookup)
```

### Configuration

**Environment variables** (`src/utils/config/index.ts` → `HYDRA_CONFIG`):

| Variable | Description |
|----------|-------------|
| `HYDRA_ENABLED` | `true` to enable L2 routing |
| `HYDRA_NODE_URL` | WebSocket URL (e.g. `ws://127.0.0.1:4001`) |
| `HYDRA_NODE_HTTP_URL` | HTTP URL for UTXO/snapshot queries |
| `HYDRA_DEBUG_LOGGING` | Log routing decisions |

### Transaction Handlers to Integrate

These handlers currently use `wallet.submitTx()` directly. To route via Hydra, switch to the transaction router:

| Handler | File | Transaction Type |
|---------|------|------------------|
| Payment batcher | `cardano-payment-batcher.service.ts` | LockFunds |
| Submit result | `cardano-submit-result-handler.service.ts` | SubmitResult |
| Request refund | `cardano-request-refund-handler.service.ts` | RequestRefund |
| Cancel refund | `cardano-cancel-refund-handler.service.ts` | CancelRefund |
| Authorize refund | `cardano-authorize-refund-handler.service.ts` | AuthorizeRefund |
| Collect payment | `cardano-collection-handler.service.ts` | CollectPayment |
| Collect refund | `cardano-collection-refund.service.ts` | CollectRefund |

**Example** (before → after):

```typescript
// Before (L1 only)
const txHash = await wallet.submitTx(signedTx);

// After (L1 or L2)
import { submitLockFundsTransaction } from '@/services/transaction-router';
const result = await submitLockFundsTransaction(signedTx, {
  paymentSourceId,
  purchaseRequestId,
  buyerAgentId: decoded.purchaserId,
  sellerAgentId: decoded.sellerId,
  network,
  wallet,
});
const txHash = result.txHash;
```

### Agent IDs for Routing

- **buyerAgentId**: `purchaserId` from `decodeBlockchainIdentifier(blockchainIdentifier)`
- **sellerAgentId**: `sellerId` from `decodeBlockchainIdentifier(blockchainIdentifier)`

## Hydra Node API (Reference)

| Command/Endpoint | Purpose |
|------------------|---------|
| `{"tag": "NewTx", "transaction": <cbor>}` | Submit transaction to head |
| `GET /snapshot/utxo` | Query current UTXOs in head |
| `{"tag": "Init"}` | Initialize head |
| `{"tag": "Close"}` | Close head |
| `{"tag": "Fanout"}` | Fan out final state to L1 |

## Next Steps for Full Implementation

### 1. Integrate Transaction Router into Handlers

Replace direct `wallet.submitTx()` calls with the transaction router helpers. Each handler must pass the routing context (agent IDs, payment source, etc.) so the router can decide L1 vs L2.

#### 1.1 Payment Batcher (Lock Funds)

**File**: `src/services/cardano-payment-batcher/cardano-payment-batcher.service.ts`

**Location**: Inside `executeSpecificBatchPayment`, after `wallet.signTx(completeTx)`.

**Current code** (~line 182):

```typescript
const signedTx = await wallet.signTx(completeTx);
const txHash = await wallet.submitTx(signedTx);
```

**Replace with**:

```typescript
import { submitLockFundsTransaction } from '@/services/transaction-router';
import { decodeBlockchainIdentifier } from '@/utils/generator/blockchain-identifier-generator';

const signedTx = await wallet.signTx(completeTx);

// For batched payments, use the first request's agent IDs for routing
const firstRequest = batchedRequests[0];
const decoded = decodeBlockchainIdentifier(firstRequest.paymentRequest.blockchainIdentifier);
const result = await submitLockFundsTransaction(signedTx, {
  paymentSourceId: paymentContract.id,
  purchaseRequestId: firstRequest.paymentRequest.id,
  buyerAgentId: decoded?.purchaserId ?? '',
  sellerAgentId: decoded?.sellerId ?? '',
  network: convertNetwork(paymentContract.network),
  wallet,
});
const txHash = result.txHash;
```

**Note**: Batched transactions lock multiple purchases in one tx. Use the first request's agent IDs for routing; if the batch spans multiple agent pairs, consider routing per-request or defaulting to L1.

#### 1.2 Submit Result Handler

**File**: `src/services/cardano-submit-result-handler/cardano-submit-result-handler.service.ts`

**Location**: Inside `processSinglePaymentRequest`, after `wallet.signTx(unsignedTx)` (~line 280).

**Current code**:

```typescript
const newTxHash = await wallet.submitTx(signedTx);
```

**Replace with**:

```typescript
import { submitResultTransaction } from '@/services/transaction-router';
import { decodeBlockchainIdentifier } from '@/utils/generator/blockchain-identifier-generator';

const decoded = decodeBlockchainIdentifier(request.blockchainIdentifier);
const result = await submitResultTransaction(signedTx, {
  paymentSourceId: paymentContract.id,
  paymentRequestId: request.id,
  buyerAgentId: decoded?.purchaserId ?? '',
  sellerAgentId: decoded?.sellerId ?? '',
  network,
  wallet,
});
const newTxHash = result.txHash;
```

#### 1.3 Request Refund Handler

**File**: `src/services/cardano-request-refund-handler/cardano-request-refund-handler.service.ts`

**Location**: Inside `processSinglePurchaseRequest`, after signing (~line 207).

**Replace** `wallet.submitTx(signedTx)` **with**:

```typescript
import { submitRequestRefundTransaction } from '@/services/transaction-router';
import { decodeBlockchainIdentifier } from '@/utils/generator/blockchain-identifier-generator';

const decoded = decodeBlockchainIdentifier(request.blockchainIdentifier);
const result = await submitRequestRefundTransaction(signedTx, {
  paymentSourceId: paymentContract.id,
  purchaseRequestId: request.id,
  buyerAgentId: decoded?.purchaserId ?? '',
  sellerAgentId: decoded?.sellerId ?? '',
  network,
  wallet,
});
const newTxHash = result.txHash;
```

#### 1.4 Cancel Refund Handler

**File**: `src/services/cardano-cancel-refund-handler/cardano-cancel-refund-handler.service.ts`

**Location**: Inside the success path (~line 275).

**Replace** `wallet.submitTx(signedTx)` **with**:

```typescript
import { submitCancelRefundTransaction } from '@/services/transaction-router';
import { decodeBlockchainIdentifier } from '@/utils/generator/blockchain-identifier-generator';

const decoded = decodeBlockchainIdentifier(request.blockchainIdentifier);
const result = await submitCancelRefundTransaction(signedTx, {
  paymentSourceId: paymentContract.id,
  purchaseRequestId: request.id,
  buyerAgentId: decoded?.purchaserId ?? '',
  sellerAgentId: decoded?.sellerId ?? '',
  network,
  wallet,
});
const newTxHash = result.txHash;
```

#### 1.5 Authorize Refund Handler

**File**: `src/services/cardano-authorize-refund-handler/cardano-authorize-refund-handler.service.ts`

**Location**: Inside the success path (~line 229).

**Replace** `wallet.submitTx(signedTx)` **with**:

```typescript
import { submitAuthorizeRefundTransaction } from '@/services/transaction-router';
import { decodeBlockchainIdentifier } from '@/utils/generator/blockchain-identifier-generator';

const decoded = decodeBlockchainIdentifier(request.blockchainIdentifier);
const result = await submitAuthorizeRefundTransaction(signedTx, {
  paymentSourceId: paymentContract.id,
  paymentRequestId: request.id,
  buyerAgentId: decoded?.purchaserId ?? '',
  sellerAgentId: decoded?.sellerId ?? '',
  network,
  wallet,
});
const newTxHash = result.txHash;
```

#### 1.6 Collect Payment Handler

**File**: `src/services/cardano-collection-handler/cardano-collection-handler.service.ts`

**Location**: Inside `processSinglePaymentCollection`, after signing (~line 268).

**Replace** `wallet.submitTx(signedTx)` **with**:

```typescript
import { submitCollectPaymentTransaction } from '@/services/transaction-router';
import { decodeBlockchainIdentifier } from '@/utils/generator/blockchain-identifier-generator';

const decoded = decodeBlockchainIdentifier(request.blockchainIdentifier);
const result = await submitCollectPaymentTransaction(signedTx, {
  paymentSourceId: paymentContract.id,
  paymentRequestId: request.id,
  buyerAgentId: decoded?.purchaserId ?? '',
  sellerAgentId: decoded?.sellerId ?? '',
  network,
  wallet,
});
const newTxHash = result.txHash;
```

#### 1.7 Collect Refund Handler

**File**: `src/services/cardano-refund-handler/cardano-collection-refund.service.ts`

**Location**: Inside `processSingleRefundCollection`, after signing (~line 194).

**Replace** `wallet.submitTx(signedTx)` **with**:

```typescript
import { submitCollectRefundTransaction } from '@/services/transaction-router';
import { decodeBlockchainIdentifier } from '@/utils/generator/blockchain-identifier-generator';

const decoded = decodeBlockchainIdentifier(request.blockchainIdentifier);
const result = await submitCollectRefundTransaction(signedTx, {
  paymentSourceId: paymentContract.id,
  purchaseRequestId: request.id,
  buyerAgentId: decoded?.purchaserId ?? '',
  sellerAgentId: decoded?.sellerId ?? '',
  network,
  wallet,
});
const newTxHash = result.txHash;
```

---

### 2. Integrate @masumi-hydra Package

**File**: `src/services/hydra/hydra-manager.ts`

The hydra-manager currently uses placeholder instances. Replace with real `@masumi-hydra` HydraHead:

#### 2.1 Connect

- Use `ws` or `WebSocket` to connect to `config.nodeUrl`.
- On open: set `connected = true`, call `callbacks.onConnected?.()`.
- On close/error: set `connected = false`, attempt reconnect per `reconnectIntervalMs` and `maxReconnectAttempts`.

#### 2.2 Handle Incoming Events

Parse JSON messages from the WebSocket and dispatch:

| Event | Action |
|-------|--------|
| `HeadIsOpen` | Call `handleHeadIsOpen(headId, utxo)` |
| `HeadIsClosed` | Call `handleHeadIsClosed(headId)` |
| `HeadIsFinalized` | Call `handleHeadIsFinalized(headId)` |
| `TxValid` | Call `handleTxValid(transaction.txId)` |
| `TxInvalid` | Call `handleTxInvalid(transaction.txId, validationError.reason)` |
| `SnapshotConfirmed` | Call `handleSnapshotConfirmed(snapshot)` |

#### 2.3 Submit Transaction

Send to WebSocket:

```json
{"tag": "NewTx", "transaction": {"cborHex": "<signed-tx-hex>"}}
```

Wait for `TxValid` or `TxInvalid` (e.g. via Promise + event handler). On `TxValid`, resolve with `{ accepted: true, txHash }`. On `TxInvalid`, resolve with `{ accepted: false, txHash, reason }`.

#### 2.4 Extract Transaction Hash

Replace `extractTxHashFromSignedTx` with proper CBOR decoding (e.g. `@meshsdk/core` or `cbor` package) to compute the transaction ID from the signed CBOR.

#### 2.5 UTXO Queries

- Implement `getUtxos()` via `GET ${config.nodeHttpUrl}/snapshot/utxo`.
- Convert Hydra UTXO format (`{ "txHash#index": { address, value, datum, ... } }`) to MeshSDK `UTxO[]` format.

---

### 3. UTXO Provider for Transaction Building

When routing to L2, transaction builders must use UTXOs from the Hydra snapshot instead of Blockfrost.

**Affected code**: Handlers that call `blockfrostProvider.fetchAddressUTxOs()` or `blockfrostProvider.fetchUTxOs(txHash)` before building transactions.

**Approach**: Use `fetchUtxosForTransaction` or `fetchUtxosByTxHashForTransaction` from `@/services/transaction-router` instead of Blockfrost directly. Pass the same routing context (paymentSourceId, buyerAgentId, sellerAgentId) so the router fetches from L1 or L2 accordingly.

**Example**:

```typescript
import { fetchUtxosForTransaction } from '@/services/transaction-router';

const { utxos } = await fetchUtxosForTransaction(
  address,
  { paymentSourceId, buyerAgentId, sellerAgentId, network },
  blockfrostProvider,
);
```

---

### 4. Transaction Sync for L2

**File**: `src/services/update-wallet-transaction-hash-handler/` and `src/services/cardano-tx-handler/`

L2 transactions are confirmed via Hydra events (`TxValid`, `SnapshotConfirmed`), not Blockfrost. Options:

1. **Hydra event handler**: When `TxValid` or `SnapshotConfirmed` fires, update the corresponding `Transaction` record (e.g. set `txHash`, `status`, `confirmations`).
2. **Polling Hydra snapshot**: Periodically query the Hydra node for new snapshots and reconcile with pending transactions.
3. **Hybrid**: Use events for real-time updates; use polling as a fallback.

Ensure `updateWalletTransactionHash` and related logic can handle both L1 (Blockfrost) and L2 (Hydra) confirmation sources.

---

### 5. Database Schema

The Hydra head state is persisted in `prisma/schema.prisma` using two models:

- **`HydraHead`** – Represents a single Hydra head with status and lifecycle timestamps. Not tied to `PaymentSource`; routing is purely based on participant agent IDs.
- **`HydraParticipant`** – Join table between `HydraHead` and agents. Supports N participants per head. Each participant runs their own Hydra node (with its own `nodeUrl`/`nodeHttpUrl`). Participants are symmetric (no buyer/seller distinction).
- **`HydraChannel`** – A Hydra channel between exactly 2 agents, backed by a HydraHead. Provides fast indexed lookups by agent pair. Agents stored in deterministic order (lexicographically smaller ID first) so lookups are symmetric. The same pair can have multiple channels.

```prisma
enum HydraHeadStatus {
  Initializing
  Open
  Closing
  Closed
  FanOut
  Finalized
  Aborted
}

model HydraHead {
  id                   String             @id @default(cuid())
  createdAt            DateTime           @default(now())
  updatedAt            DateTime           @updatedAt
  headId               String?            @unique    // Hydra protocol head ID
  network              Network
  status               HydraHeadStatus    @default(Initializing)
  contestationPeriod   Int                @default(60)
  openedAt             DateTime?
  closedAt             DateTime?
  finalizedAt          DateTime?
  lastActivityAt       DateTime?
  lastSnapshotNumber   Int                @default(0)
  lastSnapshotUtxoHash String?
  lastError            String?
  lastErrorAt          DateTime?
  Participants         HydraParticipant[]

  @@index([status])
  @@index([network, status])
}

// Each participant runs their own Hydra node with its own WebSocket/HTTP URLs.
model HydraParticipant {
  id                     String    @id @default(cuid())
  createdAt              DateTime  @default(now())
  updatedAt              DateTime  @updatedAt
  hydraHeadId            String
  HydraHead              HydraHead @relation(...)
  agentId                String
  participantIndex       Int
  nodeUrl                String              // WebSocket URL for this participant's node
  nodeHttpUrl            String              // HTTP URL for this participant's node
  cardanoVerificationKey String?
  hydraVerificationKey   String?
  hasCommitted           Boolean   @default(false)

  @@unique([hydraHeadId, agentId])
  @@index([agentId])
  @@index([agentId, hydraHeadId])
}

// Fast lookup for 2-agent heads. Agents stored in deterministic order.
// A channel between 2 agents, backed by a Hydra head.
model HydraChannel {
  id            String    @id @default(cuid())
  createdAt     DateTime  @default(now())
  updatedAt     DateTime  @updatedAt
  hydraHeadId   String
  HydraHead     HydraHead @relation(...)
  agentIdA      String              // Lexicographically smaller agent ID
  agentIdB      String              // Lexicographically larger agent ID

  @@unique([hydraHeadId, agentIdA, agentIdB])
  @@index([agentIdA, agentIdB])
  @@index([agentIdB, agentIdA])
}
```

#### Key queries

**Find open heads between two agents** (via `HydraChannel`):

```typescript
// Store agents in deterministic order (smaller ID first)
const [sortedA, sortedB] = agentIdA < agentIdB
  ? [agentIdA, agentIdB] : [agentIdB, agentIdA];

const channels = await prisma.hydraChannel.findMany({
  where: { agentIdA: sortedA, agentIdB: sortedB },
  include: {
    HydraHead: { include: { Participants: true } },
  },
});
const openHeads = channels.filter(c => c.HydraHead.status === 'Open');
```

**Find all heads where agent X participates:**

```typescript
const heads = await prisma.hydraHead.findMany({
  where: { Participants: { some: { agentId: agentX } } },
  include: { Participants: true },
});
```

The `router.setHydraHeadFinder()` function should be wired to the first query above.

---

### 6. Testing

1. **Unit tests**: Mock `submitTransactionToHydra` and `wallet.submitTx`; assert routing decisions and correct helper usage.
2. **Integration tests**: Run against a local Hydra devnet; verify end-to-end L2 submission and confirmation.
3. **E2E**: Use `forceLayer: 'L2'` in context to force L2 in existing E2E flows when Hydra is available.

---

## Failure Scenarios and Failover

Hydra heads can fail or become unavailable for several reasons. The Masumi Payment Service must handle these gracefully and **fail over to L1** when L2 is unusable.

### 1. Consensus Failure (etcd / Raft)

Hydra uses **etcd** with Raft consensus for its network layer. Quorum requires a **majority** of nodes: `⌊n/2⌋ + 1`.

| Scenario | Impact |
|----------|--------|
| **2-party head, 1 node down** | Consensus breaks. `hydra_head_peers_connected` drops to 0. Head cannot progress. |
| **3-party head, 1 node down** | 2 remain → quorum OK. Head continues. |
| **3-party head, 2 nodes down** | Quorum lost. Head stuck. |

**Monitoring**: Expose `hydra_head_peers_connected` (Prometheus). If it drops to 0, treat L2 as unavailable.

### 2. Single Node Down (2-Agent Setup)

In the typical **buyer–seller** (2-party) head:

- If **either** Hydra node goes offline, the head **cannot make progress**.
- Snapshots require **all** participants to sign (`AckSn`).
- No new transactions are confirmed; the head is effectively stuck.

**Recovery options**:

1. **Mirror nodes**: Run backup nodes with the same keys. If one node fails, the mirror can sign. See [Run the Node on High Availability Using Mirror Nodes](https://hydra.family/head-protocol/docs/how-to/operating-hydra#run-the-node-on-high-availability-using-mirror-nodes).
2. **Close the head**: Any participant can close with the latest snapshot. After the contestation period, `FanOut` returns funds to L1.
3. **Fail over to L1**: Route all new transactions to Cardano L1 until the head is healthy again.

**Constraint**: Mirror count `k` must satisfy `k < ⌊n/2⌋` to avoid etcd quorum issues (e.g. 3 Alice + 1 Bob: max 1 mirror per party).

### 3. Peer Out of Sync (State Divergence)

When one node accepts a transaction and others reject it (e.g. different `--ledger-protocol-parameters` or a peer going offline mid-tx):

- Local ledger states **fork** across nodes.
- Snapshots stop being signed; the head is stuck.
- Transactions may be accepted locally but never confirmed globally.

**Recovery** (coordinated among peers):

1. Use `GET /snapshot` to fetch the latest **confirmed** snapshot.
2. Call `POST /snapshot` with that snapshot on **all** peers.
3. This clears pending txs and restores a consistent state; nodes can rejoin consensus.

**Mitigation**: Ensure all nodes use identical configuration and protocol parameters.

### 4. Head Stuck in Initializing

Before UTXOs are collected into the head:

- **Abort**: Participants can abort and recover funds at any time before `CollectCom`.
- **Stuck**: If committed UTXOs are too large for `CollectCom` or `Abort`, the head remains stuck in initializing. Funds are locked until protocol fixes or manual intervention.

**Mitigation**: Limit UTXO size/complexity; see [Known issues](https://hydra.family/head-protocol/docs/known-issues#head-protocol-limits).

### 5. Head Stuck in Open (Cannot Finalize)

- **> ~80 assets**: Head can be **closed** but not **finalized** (FanOut fails).
- **Minted tokens not burned**: Prevents finalization.
- **Close still works**: Any participant can close. After contestation period, state can be fanned out if within limits.

### 6. Network / Transport Failures

- **Intermittent peers**: Package drops or flaky connections can cause heads to stall. Hydra has identified this as a reliability challenge.
- **etcd auto-compaction**: Limits how long a peer can be offline before history is pruned. Configure via `ETCD_AUTO_COMPACTION_*` env vars.
- **Topology mismatch**: `--peer` must match across all nodes. Mismatches cause `cluster ID mismatch` and bootstrap failures.

### 7. Failover Strategy for Masumi Payment Service

The Transaction Router must **fail over to L1** when L2 is unavailable. Recommended behavior:

| Condition | Action |
|-----------|--------|
| Hydra client not connected | Route to L1 |
| Head status not `Open` | Route to L1 |
| `hydra_head_peers_connected === 0` | Route to L1 |
| Hydra rejects tx (`TxInvalid`) | Optionally retry on L1 for critical flows |
| Timeout / network error on submit | Retry on L1 |

**Implementation**:

1. **Layer determination**: `resolveRouting()` already falls back to L1 when `findActiveHydraHead` returns null or when the default check (connected + head Open) fails.
2. **Custom `findActiveHydraHead`**: When using the DB-backed `HydraHead` model, only return a head when:
   - `status === 'Open'`
   - Both participant agents are members of the head
   - Optional: `hydra_head_peers_connected >= required_quorum` (if metrics are available).
3. **Submit-time failover**: If `submitToL2` throws (e.g. "Hydra client not connected" or "Hydra rejected transaction"), the caller can catch and retry with `forceLayer: 'L1'`. Consider adding a `submitWithL1Fallback()` helper that does this automatically.
4. **Health checks**: Periodically verify Hydra node connectivity and head status. Update `HydraHead.status` or equivalent so routing decisions stay accurate.

**Example: submit with L1 fallback**

```typescript
// Pseudocode for resilient submission
async function submitWithFallback(signedTx, context, wallet) {
  try {
    return await router.submitTransaction(signedTx, context, wallet);
  } catch (err) {
    if (isHydraError(err) && context.forceLayer !== 'L1') {
      logger.warn('[TransactionRouter] L2 failed, retrying on L1', { err });
      return router.submitTransaction(signedTx, { ...context, forceLayer: 'L1' }, wallet);
    }
    throw err;
  }
}
```

### 8. Summary: When to Use L1 vs L2

| Scenario | Use L2? |
|----------|---------|
| Head Open, all peers connected, quorum OK | Yes |
| One node down (2-party head) | No → L1 |
| Peer out of sync, recovery in progress | No → L1 |
| Head Initializing, Closing, Closed, Aborted | No → L1 |
| Hydra client disconnected | No → L1 |
| Contestation period after Close | No → L1 (until FanOut completes) |

---

## References

- [Hydra Head Protocol](https://hydra.family/head-protocol/)
- [Hydra GitHub](https://github.com/cardano-scaling/hydra)
- [Known issues and limitations](https://hydra.family/head-protocol/docs/known-issues)
- [Operate a Hydra node](https://hydra.family/head-protocol/docs/how-to/operating-hydra)
- [ADR-32: Network layer (etcd)](https://hydra.family/head-protocol/adr/32)
