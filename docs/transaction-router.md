# Transaction Router: Detailed Flow Documentation

This document describes, step by step, how the Transaction Router handles user requests and routes them to either the Hydra node (Layer 2) or Cardano Layer 1.

---

## Table of Contents

1. [High-Level Overview](#1-high-level-overview)
2. [Request Flow: From User to Submission](#2-request-flow-from-user-to-submission)
3. [Step-by-Step: Transaction Submission Path](#3-step-by-step-transaction-submission-path)
4. [Step-by-Step: Layer Determination](#4-step-by-step-layer-determination)
5. [Step-by-Step: L2 Submission to Hydra Node](#5-step-by-step-l2-submission-to-hydra-node)
6. [Step-by-Step: L1 Submission to Cardano](#6-step-by-step-l1-submission-to-cardano)
7. [Step-by-Step: UTXO Queries](#7-step-by-step-utxo-queries)
8. [Transaction Types and Their Context](#8-transaction-types-and-their-context)
9. [Agent ID Resolution](#9-agent-id-resolution)
10. [Configuration and Initialization](#10-configuration-and-initialization)
11. [Error Handling and Edge Cases](#11-error-handling-and-edge-cases)
12. [Sequence Diagrams](#12-sequence-diagrams)

---

## 1. High-Level Overview

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                           USER REQUEST (API or Background Job)                    │
│                                                                                  │
│  Examples: POST /v1/purchase, POST /v1/purchase/request-refund,                 │
│            POST /v1/payment/submit-result, scheduled collectRefundV1(), etc.    │
└─────────────────────────────────────────────────────────────────────────────────┘
                                        │
                                        ▼
┌─────────────────────────────────────────────────────────────────────────────────┐
│                           TRANSACTION HANDLER                                    │
│                                                                                  │
│  • Builds unsigned transaction (using MeshSDK, contract datum, etc.)             │
│  • Signs transaction with wallet                                                 │
│  • Calls submit helper (e.g. submitLockFundsTransaction) instead of             │
│    wallet.submitTx() directly                                                     │
└─────────────────────────────────────────────────────────────────────────────────┘
                                        │
                                        ▼
┌─────────────────────────────────────────────────────────────────────────────────┐
│                           SUBMIT HELPER (submit-helpers.ts)                      │
│                                                                                  │
│  • Receives signedTx + context (agent IDs, payment source, wallet)               │
│  • Calls getTransactionRouter().submitTransaction(signedTx, context, wallet)     │
└─────────────────────────────────────────────────────────────────────────────────┘
                                        │
                                        ▼
┌─────────────────────────────────────────────────────────────────────────────────┐
│                           TRANSACTION ROUTER (transaction-router.service.ts)     │
│                                                                                  │
│  Step 1: determineLayer(context) → 'L1' or 'L2'                                  │
│  Step 2: If L2 → submitToL2() → Hydra Client → Hydra Node                        │
│         If L1 → submitToL1() → wallet.submitTx() → Blockfrost → Cardano          │
└─────────────────────────────────────────────────────────────────────────────────┘
```

---

## 2. Request Flow: From User to Submission

### 2.1 User Request Entry Points

| User Action | API Endpoint | Background Job | Handler Service |
|-------------|--------------|----------------|-----------------|
| Hire agent (lock funds) | `POST /v1/purchase` | `batchLatestPaymentEntriesV1` | `cardano-payment-batcher.service.ts` |
| Submit result | `POST /v1/payment/submit-result` | `submitResultV1` | `cardano-submit-result-handler.service.ts` |
| Request refund | `POST /v1/purchase/request-refund` | `requestRefundsV1` | `cardano-request-refund-handler.service.ts` |
| Cancel refund | `POST /v1/purchase/cancel-refund-request` | `cancelRefundsV1` | `cardano-cancel-refund-handler.service.ts` |
| Authorize refund | `POST /v1/payment/authorize-refund` | `authorizeRefundV1` | `cardano-authorize-refund-handler.service.ts` |
| Collect payment | (automatic) | `collectOutstandingPaymentsV1` | `cardano-collection-handler.service.ts` |
| Collect refund | (automatic) | `collectRefundV1` | `cardano-collection-refund.service.ts` |

### 2.2 Flow for Each Request Type

1. **API request** or **scheduled job** triggers the handler.
2. Handler loads data from DB (purchase/payment request, wallet, contract params).
3. Handler builds the **unsigned transaction** (inputs, outputs, datum, redeemer).
4. Handler signs with `wallet.signTx(unsignedTx)`.
5. Handler calls the **submit helper** with `signedTx` and **routing context**.
6. Submit helper delegates to the **Transaction Router**.
7. Router decides L1 or L2, then submits accordingly.
8. Handler receives `{ txHash, layer }` and updates the DB.

---

## 3. Step-by-Step: Transaction Submission Path

### Step 3.1: Handler Calls Submit Helper

**Example: Lock Funds (Hire Agent)**

```typescript
// In cardano-payment-batcher.service.ts (when integrated)
import { submitLockFundsTransaction } from '@/services/transaction-router';
import { decodeBlockchainIdentifier } from '@/utils/generator/blockchain-identifier-generator';

const signedTx = await wallet.signTx(completeTx);

const decoded = decodeBlockchainIdentifier(firstRequest.paymentRequest.blockchainIdentifier);
const result = await submitLockFundsTransaction(signedTx, {
  paymentSourceId: paymentContract.id,
  purchaseRequestId: firstRequest.paymentRequest.id,
  buyerAgentId: decoded?.purchaserId ?? '',
  sellerAgentId: decoded?.sellerId ?? '',
  network: convertNetwork(paymentContract.network),
  wallet,
});

const txHash = result.txHash;  // Use this to update DB
```

**What happens:**

1. Handler has a **signed transaction** (CBOR hex string).
2. Handler decodes `blockchainIdentifier` to get `purchaserId` (buyer) and `sellerId` (seller).
3. Handler calls `submitLockFundsTransaction(signedTx, context)`.
4. Context includes: `paymentSourceId`, `purchaseRequestId`, `buyerAgentId`, `sellerAgentId`, `network`, `wallet`.

---

### Step 3.2: Submit Helper Receives and Forwards

**File**: `src/services/transaction-router/submit-helpers.ts`

**For `submitLockFundsTransaction`:**

```
Step 1: Log "[SubmitHelper] Submitting LockFunds transaction" with purchaseRequestId
Step 2: Call getTransactionRouter() → returns singleton TransactionRouter instance
Step 3: Call router.submitTransaction(signedTx, routingContext, context.wallet)

        routingContext = {
          transactionType: 'LockFunds',
          paymentSourceId: context.paymentSourceId,
          purchaseRequestId: context.purchaseRequestId,
          buyerAgentId: context.buyerAgentId,
          sellerAgentId: context.sellerAgentId,
          network: context.network,
          forceLayer: context.forceLayer,  // optional override
        }
```

**What happens:**

1. Submit helper does **not** decide L1 vs L2.
2. It only constructs `TransactionRoutingContext` and passes it to the router.
3. If `forceLayer` is set (e.g. `'L2'` for testing), it is included in the context.

---

### Step 3.3: Router Receives `submitTransaction` Call

**File**: `src/services/transaction-router/transaction-router.service.ts`

**Method**: `submitTransaction(signedTx, context, wallet)`

```
Step 1: Call determineLayer(context)
        → Returns 'L1' or 'L2'

Step 2: If HYDRA_DEBUG_LOGGING is true:
        Log "[TransactionRouter] Routing decision" with:
        - transactionType
        - layer (L1 or L2)
        - paymentSourceId
        - buyerAgentId
        - sellerAgentId

Step 3: If layer === 'L2':
        Return await this.submitToL2(signedTx, context)
        Else:
        Return await this.submitToL1(signedTx, wallet)
```

**What happens:**

1. The router's **first** action is to determine the layer.
2. No submission occurs until the layer is decided.
3. The decision is **per-transaction**; each call to `submitTransaction` re-evaluates.

---

## 4. Step-by-Step: Layer Determination

**Method**: `determineLayer(context): Promise<TransactionLayer>`

The router evaluates conditions **in order**. The first match wins.

### Step 4.1: Check Force Override

```
Condition: context.forceLayer is defined (e.g. 'L1' or 'L2')
Action:    Return context.forceLayer immediately
Purpose:   Testing, manual override, or API parameter to force a specific layer
```

**Example**: `forceLayer: 'L2'` → always use Hydra, regardless of head status.

---

### Step 4.2: Check Global Hydra Enable

```
Condition: this.config.hydraEnabled === false
Source:    HYDRA_CONFIG.ENABLED (from process.env.HYDRA_ENABLED === 'true')
Action:    Return 'L1'
Purpose:   When Hydra is disabled, all transactions go to Cardano L1
```

**Example**: `HYDRA_ENABLED` not set or `false` → all requests go to L1.

---

### Step 4.3: Check Custom "Is Hydra Active" Flag (If Set)

```
Condition: this.isHydraActiveForAgents is not null
           (set via router.setHydraActiveCheck(fn))
Action:    Call fn(buyerAgentId, sellerAgentId, paymentSourceId)
           - buyerAgentId = context.buyerAgentId ?? ''
           - sellerAgentId = context.sellerAgentId ?? ''
           - paymentSourceId = context.paymentSourceId
        If fn returns true (or Promise<true>):  Return 'L2'
        Else:                                   Return 'L1'
Purpose:   Custom logic (e.g. DB lookup) to decide if a Hydra head exists
           between these two agents
```

**Example**: Application sets `router.setHydraActiveCheck(async (buyer, seller, psId) => { return await db.hydraHead.findFirst({ where: { buyerAgentId: buyer, sellerAgentId: seller, paymentSourceId: psId, status: 'Open' } }) })`.

---

### Step 4.4: Default Check (No Custom Flag)

```
Condition: this.isHydraActiveForAgents is null
Action:    1. Call getOrCreateHydraClient(context.paymentSourceId)
           2. If hydraClient.isConnected() === true
              AND hydraClient.getHeadStatus() === HydraHeadStatus.Open
              → Return 'L2'
           3. Else → Return 'L1'
Purpose:   Use Hydra when we have a connected client and an open head
           for this payment source
```

**Detailed sub-steps:**

1. **getOrCreateHydraClient(paymentSourceId)**:
   - Look up `hydraClients.get(paymentSourceId)`.
   - If no client exists: create `new HydraClient(config)` with `HYDRA_CONFIG` (nodeUrl, nodeHttpUrl, etc.), store in map.
   - Return the client.

2. **hydraClient.isConnected()**:
   - Returns `this.connected` (boolean).
   - In current implementation: `connect()` sets it to `true`; `disconnect()` sets it to `false`.

3. **hydraClient.getHeadStatus()**:
   - Returns `HydraHeadStatus` enum: `Initializing`, `Open`, `Closing`, `Closed`, `Aborted`.
   - Only `Open` allows transaction submission.

---

### Step 4.5: Summary Table

| Step | Condition | Result |
|------|-----------|--------|
| 1 | `context.forceLayer` is set | Use that layer |
| 2 | `HYDRA_ENABLED` is false | L1 |
| 3 | Custom `isHydraActiveForAgents` returns true | L2 |
| 4 | Custom `isHydraActiveForAgents` returns false | L1 |
| 5 | Hydra client connected AND head status is Open | L2 |
| 6 | Otherwise | L1 |

---

## 5. Step-by-Step: L2 Submission to Hydra Node

**Method**: `submitToL2(signedTx, context): Promise<TransactionSubmitResult>`

### Step 5.1: Log and Get Client

```
Step 1: Log "[TransactionRouter] Submitting to L2 (Hydra)"
Step 2: client = getOrCreateHydraClient(context.paymentSourceId)
        → Ensures a HydraClient exists for this payment source
```

---

### Step 5.2: Validate Client State

```
Step 3: If !client.isConnected():
        Throw Error('Hydra client not connected; cannot submit to L2')
```

**Why**: L2 submission requires an active WebSocket connection to the Hydra node.

---

### Step 5.3: Submit via Hydra Client

```
Step 4: result = await client.submitTransaction(signedTx)
```

**Inside `HydraClient.submitTransaction(signedTx)`:**

1. **Check connected**: If not connected → throw.
2. **Check head status**: If `headStatus !== HydraHeadStatus.Open` → throw.
3. **Log**: `"[HydraClient] Submitting transaction to Hydra head"` with tx length and headId.
4. **Send to Hydra** (when implemented):
   - Serialize: `{"tag": "NewTx", "transaction": {"cborHex": signedTx}}`
   - Send over WebSocket to `config.nodeUrl` (e.g. `ws://127.0.0.1:4001`)
   - Wait for `TxValid` or `TxInvalid` event
5. **Extract txHash**: From signed CBOR (or from `TxValid` event).
6. **Return**: `{ accepted: true, txHash }` or `{ accepted: false, txHash, reason }`.

---

### Step 5.4: Validate Hydra Response

```
Step 5: If !result.accepted:
        Throw Error(`Hydra rejected transaction: ${result.reason ?? 'unknown'}`)
```

**Why**: Hydra can reject invalid transactions (e.g. invalid script, insufficient funds in head).

---

### Step 5.5: Return Success

```
Step 6: Log "[TransactionRouter] L2 submission successful" with txHash
Step 7: Return {
          txHash: result.txHash,
          layer: 'L2',
          timestamp: new Date(),
        }
```

**What the handler receives**: Same shape as L1 (`txHash`, `layer`, `timestamp`), but `layer === 'L2'`.

---

### Step 5.6: Hydra Node Protocol (Reference)

When the WebSocket implementation is complete, the flow is:

```
Payment Service                          Hydra Node
      |                                       |
      |  {"tag":"NewTx","transaction":{...}}  |
      |-------------------------------------->|
      |                                       |
      |  (Hydra validates tx against head     |
      |   snapshot and ledger rules)          |
      |                                       |
      |  {"tag":"TxValid","transaction":      |
      |   {"txId":"abc123..."}}               |
      |<--------------------------------------|
      |                                       |
```

If invalid:

```
      |  {"tag":"TxInvalid","transaction":{...},
      |   "validationError":{"reason":"..."}}  |
      |<--------------------------------------|
```

---

## 6. Step-by-Step: L1 Submission to Cardano

**Method**: `submitToL1(signedTx, wallet): Promise<TransactionSubmitResult>`

### Step 6.1: Log

```
Step 1: Log "[TransactionRouter] Submitting to L1 (Cardano)"
```

---

### Step 6.2: Submit via Mesh Wallet

```
Step 2: txHash = await wallet.submitTx(signedTx)
```

**What `wallet.submitTx` does** (MeshSDK):

1. Sends the signed transaction to the configured provider (Blockfrost).
2. Blockfrost broadcasts the transaction to the Cardano network.
3. Returns the transaction ID (hash) as a string.

---

### Step 6.3: Return Success

```
Step 3: Log "[TransactionRouter] L1 submission successful" with txHash
Step 4: Return {
          txHash,
          layer: 'L1',
          timestamp: new Date(),
        }
```

---

## 7. Step-by-Step: UTXO Queries

When building transactions, handlers need UTXOs (unspent outputs). The router can fetch them from L1 (Blockfrost) or L2 (Hydra snapshot).

### Step 7.1: `fetchUtxos(address, context, blockfrostProvider)`

```
Step 1: layer = await this.determineLayer(context)
Step 2: If layer === 'L2':
        Return await this.fetchUtxosFromL2(address, context)
        Else:
        Return await this.fetchUtxosFromL1(address, blockfrostProvider)
```

**fetchUtxosFromL1**:

1. Log `"[TransactionRouter] Fetching UTXOs from L1"`.
2. `utxos = await blockfrostProvider.fetchAddressUTxOs(address)`.
3. Return `{ utxos, layer: 'L1' }`.

**fetchUtxosFromL2**:

1. Log `"[TransactionRouter] Fetching UTXOs from L2"`.
2. `client = getOrCreateHydraClient(context.paymentSourceId)`.
3. If `!client.isConnected()` → throw.
4. `utxos = await client.getUtxosByAddress(address)` (from Hydra snapshot).
5. Return `{ utxos, layer: 'L2' }`.

---

### Step 7.2: `fetchUtxosByTxHash(txHash, context, blockfrostProvider)`

Same logic: determine layer, then fetch from Blockfrost or Hydra by transaction hash.

---

### Step 7.3: Submit Helper Wrappers

- `fetchUtxosForTransaction(address, context, blockfrostProvider)`
- `fetchUtxosByTxHashForTransaction(txHash, context, blockfrostProvider)`

These build a minimal `TransactionRoutingContext` and call the router's `fetchUtxos` / `fetchUtxosByTxHash`.

---

## 8. Transaction Types and Their Context

| Transaction Type | Submit Helper | Context Shape | Used By |
|------------------|---------------|---------------|---------|
| LockFunds | `submitLockFundsTransaction` | PurchaseSubmitContext | Payment batcher |
| SubmitResult | `submitResultTransaction` | PaymentSubmitContext | Submit result handler |
| RequestRefund | `submitRequestRefundTransaction` | PurchaseSubmitContext | Request refund handler |
| CancelRefund | `submitCancelRefundTransaction` | PurchaseSubmitContext | Cancel refund handler |
| AuthorizeRefund | `submitAuthorizeRefundTransaction` | PaymentSubmitContext | Authorize refund handler |
| CollectPayment | `submitCollectPaymentTransaction` | PaymentSubmitContext | Collection handler |
| CollectRefund | `submitCollectRefundTransaction` | PurchaseSubmitContext | Refund collection handler |

**PurchaseSubmitContext**: `paymentSourceId`, `purchaseRequestId`, `buyerAgentId`, `sellerAgentId`, `network`, `wallet`, optional `forceLayer`.

**PaymentSubmitContext**: `paymentSourceId`, `paymentRequestId`, `buyerAgentId`, `sellerAgentId`, `network`, `wallet`, optional `forceLayer`.

---

## 9. Agent ID Resolution

Agent IDs come from the `blockchainIdentifier` stored on each purchase/payment request.

### 9.1 Decoding

```typescript
import { decodeBlockchainIdentifier } from '@/utils/generator/blockchain-identifier-generator';

const decoded = decodeBlockchainIdentifier(request.blockchainIdentifier);
// decoded.purchaserId  → buyerAgentId (hex string)
// decoded.sellerId    → sellerAgentId (hex string, may include agentIdentifier if length > 64)
```

### 9.2 Format

- `blockchainIdentifier` is LZ-compressed, hex-encoded: `sellerId.buyerId.signature.key`.
- `purchaserId` = buyer's nonce/identifier (hex).
- `sellerId` = seller's nonce + optional agent identifier (hex; if length > 64, `agentIdentifier = sellerId.slice(64)`).

### 9.3 Usage in Router

The router uses `buyerAgentId` and `sellerAgentId` only when:

1. A custom `isHydraActiveForAgents` is set (to look up heads by agent pair).
2. For logging when `debugLogging` is enabled.

The default layer check does **not** use agent IDs; it only checks client connection and head status.

---

## 10. Configuration and Initialization

### 10.1 Environment Variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `HYDRA_ENABLED` | (unset → false) | Master switch for L2 routing |
| `HYDRA_NODE_URL` | `ws://127.0.0.1:4001` | Hydra WebSocket URL |
| `HYDRA_NODE_HTTP_URL` | `http://127.0.0.1:4001` | Hydra HTTP URL (UTXOs, etc.) |
| `HYDRA_DEBUG_LOGGING` | (unset → false) | Log each routing decision |

### 10.2 Router Singleton

```typescript
import { getTransactionRouter, initTransactionRouter } from '@/services/transaction-router';

// Get default singleton (uses HYDRA_CONFIG)
const router = getTransactionRouter();

// Or initialize with custom config
initTransactionRouter({ hydraEnabled: true, debugLogging: true });
```

### 10.3 Custom Hydra Check

```typescript
const router = getTransactionRouter();
router.setHydraActiveCheck(async (buyerId, sellerId, paymentSourceId) => {
  const head = await prisma.hydraHead.findFirst({
    where: {
      paymentSourceId,
      status: 'Open',
      OR: [
        { buyerAgentId: buyerId, sellerAgentId: sellerId },
        { buyerAgentId: sellerId, sellerAgentId: buyerId },
      ],
    },
  });
  return head !== null;
});
```

---

## 11. Error Handling and Edge Cases

### 11.1 L2 Submission Errors

| Scenario | Error | Handler Impact |
|----------|-------|----------------|
| Hydra client not connected | `'Hydra client not connected; cannot submit to L2'` | Handler catches, may retry or mark for manual action |
| Head not open | `'Cannot submit transaction: head is {status}'` | From HydraClient.submitTransaction |
| Hydra rejects tx | `'Hydra rejected transaction: {reason}'` | Handler should not retry same tx; log and escalate |

### 11.2 L1 Fallback

The router does **not** automatically fall back to L1 if L2 fails. The handler must catch errors and decide (e.g. retry on L1, or fail).

### 11.3 Missing Agent IDs

If `buyerAgentId` or `sellerAgentId` is empty:

- Custom `isHydraActiveForAgents` receives `''` for missing IDs.
- Default check does not use agent IDs, so behavior is unchanged.

### 11.4 Multiple Payment Sources

Each `paymentSourceId` has its own Hydra client. Different payment sources can use different Hydra nodes (when per-source config is supported).

---

## 12. Sequence Diagrams

### 12.1 Full Flow: User Request → L2 Submission

```
User/API          Handler              SubmitHelper         Router              HydraClient       Hydra Node
   |                  |                      |                  |                      |                 |
   |  POST /request   |                      |                  |                      |                 |
   |----------------->|                      |                  |                      |                 |
   |                  | Build tx, sign       |                  |                      |                 |
   |                  |---------------------|                  |                      |                 |
   |                  | submitLockFundsTx()  |                  |                      |                 |
   |                  |-------------------->|                  |                      |                 |
   |                  |                      | getRouter()      |                      |                 |
   |                  |                      |----------------->|                      |                 |
   |                  |                      | submitTransaction()|                      |                 |
   |                  |                      |----------------->|                      |                 |
   |                  |                      |                  | determineLayer()     |                 |
   |                  |                      |                  |--------+             |                 |
   |                  |                      |                  |        | getClient() |                 |
   |                  |                      |                  |        | isConnected?|                 |
   |                  |                      |                  |        | headOpen?   |                 |
   |                  |                      |                  |<-------+             |                 |
   |                  |                      |                  | layer='L2'           |                 |
   |                  |                      |                  | submitToL2()        |                 |
   |                  |                      |                  |-------------------->|                 |
   |                  |                      |                  |                      | submitTransaction()
   |                  |                      |                  |                      | NewTx (WS)     |
   |                  |                      |                  |                      |---------------->|
   |                  |                      |                  |                      | TxValid        |
   |                  |                      |                  |                      |<----------------|
   |                  |                      |                  | {txHash, accepted}   |                 |
   |                  |                      |                  |<--------------------|                 |
   |                  |                      | {txHash, layer}   |                      |                 |
   |                  |                      |<------------------|                      |                 |
   |                  | Update DB            |                  |                      |                 |
   |                  |<---------------------|                  |                      |                 |
   |  200 OK          |                      |                  |                      |                 |
   |<-----------------|                      |                  |                      |                 |
```

### 12.2 Full Flow: User Request → L1 Submission

```
User/API          Handler              SubmitHelper         Router              Wallet/Blockfrost   Cardano
   |                  |                      |                  |                      |                 |
   |  POST /request   |                      |                  |                      |                 |
   |----------------->|                      |                  |                      |                 |
   |                  | Build tx, sign       |                  |                      |                 |
   |                  | submitLockFundsTx() |                  |                      |                 |
   |                  |-------------------->|----------------->|                      |                 |
   |                  |                      |                  | determineLayer()     |                 |
   |                  |                      |                  | HYDRA_ENABLED=false  |                 |
   |                  |                      |                  | OR no head           |                 |
   |                  |                      |                  | layer='L1'           |                 |
   |                  |                      |                  | submitToL1()         |                 |
   |                  |                      |                  |-------------------->|                 |
   |                  |                      |                  |                      | submitTx()     |
   |                  |                      |                  |                      |---------------->|
   |                  |                      |                  |                      | txHash         |
   |                  |                      |                  |<---------------------|                 |
   |                  |                      | {txHash, layer}   |                      |                 |
   |                  |                      |<------------------|                      |                 |
   |                  | Update DB            |                  |                      |                 |
   |                  |<---------------------|                  |                      |                 |
   |  200 OK          |                      |                  |                      |                 |
   |<-----------------|                      |                  |                      |                 |
```

---

## Summary

1. **User requests** (API or jobs) trigger handlers that build and sign transactions.
2. Handlers call **submit helpers** with `signedTx` and **routing context** (agent IDs, payment source, wallet).
3. Submit helpers forward to the **Transaction Router**.
4. The router **determines the layer** (L1 or L2) using: force override → HYDRA_ENABLED → custom flag → default (client + head status).
5. **L2**: Router calls HydraClient, which sends `NewTx` over WebSocket to the Hydra node and waits for `TxValid`/`TxInvalid`.
6. **L1**: Router calls `wallet.submitTx()`, which uses Blockfrost to submit to Cardano.
7. The router returns `{ txHash, layer, timestamp }` in both cases.
8. Handlers use `txHash` to update the database; `layer` can be used for logging or analytics.
