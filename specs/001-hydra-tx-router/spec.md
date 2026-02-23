# Feature Specification: Hydra L2 Transaction Router

**Feature Branch**: `001-hydra-tx-router`  
**Created**: 2026-02-23  
**Status**: Draft  
**Input**: User description: "Build transaction re-router to integrate Hydra (Cardano Layer 2 solution) for scalability and small fees. Masumi payment service provides payment infrastructure between agents (who sell their AI agent to others or external buyers). Payments are currently based on Cardano L1 which is slow and requires fees for every transaction. Hydra Heads open between 2 participants and every transaction between them is instant and fee-free, with the result settled on L1 at the end."

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Transparent L1/L2 Transaction Routing (Priority: P1)

As a payment handler (background job), when I submit a signed transaction (lock funds, submit result, refund, collect, etc.), the system automatically determines whether to send it to Cardano L1 or a Hydra L2 head based on the relationship between the two participants involved. If an open Hydra head exists between them, the transaction is routed to L2 for instant, fee-free settlement. Otherwise, it falls back to L1 seamlessly. The handler receives a uniform result regardless of which layer processed the transaction.

**Why this priority**: This is the core capability. Without transparent routing, no other Hydra features deliver value. Every other story depends on transactions being routable to L2.

**Independent Test**: Can be tested by configuring a mock Hydra head finder that returns an open head for a specific participant pair, then verifying that a signed transaction is routed to L2 and returns a transaction hash. Can also be tested by confirming L1 fallback when no open head exists.

**Acceptance Scenarios**:

1. **Given** Hydra is enabled and an open Hydra head exists between participant A and participant B, **When** a LockFunds transaction is submitted for A and B, **Then** the transaction is routed to L2 and the result contains `layer: 'L2'` and a valid transaction hash.
2. **Given** Hydra is enabled but no open Hydra head exists between participant A and participant B, **When** a transaction is submitted for A and B, **Then** the transaction is routed to L1 and the result contains `layer: 'L1'`.
3. **Given** Hydra is globally disabled (`HYDRA_ENABLED=false`), **When** any transaction is submitted, **Then** the transaction is routed to L1 without querying the database for Hydra heads.
4. **Given** `forceLayer` is set to `'L1'` in the routing context, **When** a transaction is submitted, **Then** the transaction is routed to L1 regardless of head availability.
5. **Given** an open Hydra head exists but the Hydra node is disconnected, **When** a transaction is submitted, **Then** the submission fails with a descriptive error and the handler can retry on L1.

---

### User Story 2 - Hydra Head Lifecycle Management (Priority: P2)

As an operator (or automated system process), I need to be able to create a Hydra relation between two participants, initialize a Hydra head, track its lifecycle through states (Idle → Initializing → Open → Closed → FanoutPossible → Final), and have the system accurately record and query this state. When a head is open, it should be discoverable by the transaction router. When a head closes and fans out, L2 transactions should be reconciled with L1.

**Why this priority**: Without persistent head state in the database and lifecycle tracking, the router cannot determine which layer to use. This is the data foundation for the routing decision.

**Independent Test**: Can be tested by creating HydraRelation and HydraHead records in the database, transitioning the head through states, and verifying the router's head finder returns the correct result at each state.

**Acceptance Scenarios**:

1. **Given** two participants who have never interacted via Hydra, **When** a HydraRelation is created for them, **Then** the participant IDs are stored in deterministic lexicographic order and a unique constraint prevents duplicates for the same network.
2. **Given** a HydraRelation exists, **When** a HydraHead is created within it with status `Open`, **Then** the transaction router's head finder returns this head for the participant pair.
3. **Given** a HydraHead with status `Open`, **When** the head transitions to `Closed`, **Then** the router's head finder no longer returns this head and transactions fall back to L1.
4. **Given** a HydraHead that has reached `Final` status (fanned out), **When** the sync service detects this, **Then** L2 transactions associated with this head are flagged for reconciliation and the head instance is removed from cache.

---

### User Story 3 - Hydra Head Instance Caching and Connection Management (Priority: P2)

As the system, when the transaction router resolves a transaction to L2, I need a cached, connected Hydra head instance ready to submit transactions. The first time a head is used, the system creates and connects the instance. Subsequent transactions to the same head reuse the cached instance. Concurrent requests for the same head must not create duplicate instances.

**Why this priority**: Without instance caching, every L2 transaction would require creating a new WebSocket connection to the Hydra node, which is slow and wasteful. Concurrent safety prevents race conditions.

**Independent Test**: Can be tested by requesting the same head instance from two concurrent callers and verifying only one instance is created.

**Acceptance Scenarios**:

1. **Given** no cached instance exists for a head, **When** `getOrCreateHydraHead` is called, **Then** a new instance is created, connected, and cached.
2. **Given** a cached instance exists for a head, **When** `getOrCreateHydraHead` is called again, **Then** the existing instance is returned without creating a new one.
3. **Given** two concurrent calls to `getOrCreateHydraHead` for the same head, **When** both execute simultaneously, **Then** only one instance is created (mutex prevents race condition).
4. **Given** a head has been finalized, **When** `removeHydraHead` is called, **Then** the instance is removed from cache and its mutex is cleaned up.

---

### User Story 4 - L2 UTXO Queries for Transaction Building (Priority: P3)

As a payment handler building a transaction, I need to fetch UTXOs (unspent transaction outputs) from the correct layer. When an open Hydra head exists between the two participants, UTXOs should come from the Hydra head's snapshot (L2 state). Otherwise, UTXOs come from Blockfrost (L1). This ensures transactions are built against the correct ledger state for whichever layer they will be submitted to.

**Why this priority**: Transaction building requires UTXOs. Querying the wrong layer's UTXOs would produce invalid transactions. However, this can be deferred until the L2 provider integration with `@masumi-hydra` is complete.

**Independent Test**: Can be tested by mocking the Hydra provider to return a known UTXO set and verifying the router returns L2 UTXOs when a head is open.

**Acceptance Scenarios**:

1. **Given** an open Hydra head exists between two participants, **When** UTXOs are fetched for an address, **Then** UTXOs come from the Hydra head snapshot and the result contains `layer: 'L2'`.
2. **Given** no open Hydra head exists, **When** UTXOs are fetched for an address, **Then** UTXOs come from Blockfrost (L1).

---

### User Story 5 - Background Sync and L2→L1 Reconciliation (Priority: P3)

As the system, I need a background service that periodically monitors active Hydra heads, records confirmed snapshots, detects status changes, and reconciles L2 transactions with L1 after a head fans out. When a head reaches its Final state, all L2 transactions processed through that head should be associated with the resulting L1 fanout transaction.

**Why this priority**: Reconciliation ensures that the L2 activity is properly reflected in the L1 ledger after the head closes. Without it, L2 transactions would be orphaned from L1 state. This is important for auditability and correctness but can be implemented after core routing works.

**Independent Test**: Can be tested by creating a head with associated L2 transactions, simulating a status change to Final, and verifying the reconciliation logic runs and marks transactions appropriately.

**Acceptance Scenarios**:

1. **Given** an open Hydra head with a new snapshot, **When** the sync service runs, **Then** the snapshot is recorded in the database with its number and UTXO hash.
2. **Given** a Hydra head transitions to `Final`, **When** the sync service detects this, **Then** L2 transactions are flagged for reconciliation, the fanout transaction hash is recorded, and the head instance is removed from cache.
3. **Given** a Hydra head has no live instance in cache, **When** the sync service runs, **Then** that head is skipped without error.

---

### User Story 6 - Encrypted Secret Key Storage for Hydra Participants (Priority: P3)

As the system, when storing Hydra participant key material (fund wallet signing key, node wallet signing key, Hydra signing key), the keys must be encrypted at rest using the project's encryption utilities. Decryption only occurs when the keys are needed to operate the Hydra node.

**Why this priority**: Security is critical for key material, but the encryption infrastructure already exists in the project. This story ensures it is applied correctly to Hydra secrets.

**Independent Test**: Can be tested by storing a HydraSecret with encrypted keys and verifying the decrypted values match the originals.

**Acceptance Scenarios**:

1. **Given** a Hydra participant's key material, **When** it is stored in the database, **Then** all three key fields (fundWalletSK, nodeWalletSK, hydraSK) are encrypted using the project's `encrypt()` utility.
2. **Given** encrypted key material in the database, **When** it is loaded for Hydra node operation, **Then** the keys are decrypted using the project's `decrypt()` utility and never logged.

---

### Edge Cases

- What happens when a Hydra head closes between the routing decision and the actual submission? The L2 submission fails and throws an error; the handler can retry with `forceLayer: 'L1'`.
- What happens when both participants have no Hydra node running? The head finder returns null, and all transactions go to L1 — no degradation to existing functionality.
- What happens when a HydraRelation has multiple heads and more than one is Open? The head finder returns the most recently created Open head (ordered by `createdAt desc`, take 1).
- What happens when one participant's Hydra node goes down during an open head? The head cannot progress (snapshots require all participants); the sync service updates the head status and subsequent transactions fall back to L1.
- What happens when participant IDs are provided in different orders for the same pair? The lookup normalizes order lexicographically, so `(A, B)` and `(B, A)` resolve to the same HydraRelation.
- What happens when a head has more than 80 assets committed and tries to fan out? Fanout may fail due to Cardano transaction size limits; the system should limit committed assets before closing.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: System MUST route signed transactions to L2 (Hydra) when an open Hydra head exists between the two participants, and to L1 (Cardano) otherwise.
- **FR-002**: System MUST support a global enable/disable switch (`HYDRA_ENABLED`) that, when disabled, routes all transactions to L1 without any database queries.
- **FR-003**: System MUST support a per-transaction `forceLayer` override that bypasses the routing logic.
- **FR-004**: System MUST return a uniform result shape (`txHash`, `layer`, `timestamp`) regardless of which layer processed the transaction.
- **FR-005**: System MUST persist Hydra head lifecycle state (Idle, Initializing, Open, Closed, FanoutPossible, Final) in the database and update it when status changes are detected.
- **FR-006**: System MUST store participant pairs in deterministic lexicographic order to ensure symmetric lookup (i.e., querying for (A, B) or (B, A) returns the same relation).
- **FR-007**: System MUST cache Hydra head instances in memory with mutex-protected creation to prevent duplicate instances for the same head.
- **FR-008**: System MUST encrypt all Hydra participant secret keys (fundWalletSK, nodeWalletSK, hydraSK) at rest using the project's encryption utilities.
- **FR-009**: System MUST periodically sync active Hydra heads to detect status changes and record confirmed snapshots.
- **FR-010**: System MUST reconcile L2 transactions with L1 after a head fans out (reaches Final state).
- **FR-011**: System MUST route UTXO queries to the correct layer (L1 via Blockfrost, L2 via Hydra snapshot) based on the same routing logic used for transaction submission.
- **FR-012**: System MUST support all existing payment contract transaction types through the router: LockFunds, SubmitResult, RequestRefund, CancelRefund, AuthorizeRefund, CollectPayment, CollectRefund.
- **FR-013**: System MUST track which layer each transaction was submitted to (L1 or L2) and, for L2 transactions, which Hydra head processed them.
- **FR-014**: System MUST support participants of different types (registered agents and external marketplace buyers) in the same Hydra head.

### Key Entities

- **HydraRelation**: A persistent relationship between exactly two participants on a specific Cardano network. Serves as the primary lookup key for routing decisions. One relation per unique participant pair per network. Can have multiple HydraHead sessions over its lifetime.
- **HydraHead**: A single Hydra head session within a relation. Tracks the protocol lifecycle (Idle → Open → Closed → Final), snapshot state, contestation period, and lifecycle timestamps. Each head has exactly 2 participants.
- **HydraParticipant**: A participant in a Hydra head. Stores per-head connection info (node WebSocket/HTTP URLs), verification keys, commit status, and a reference to encrypted key material. Linked to a participant ID which can be an agent or external buyer.
- **HydraSecret**: Encrypted storage for a participant's three secret keys (fund wallet SK, node wallet SK, Hydra SK). One-to-one relationship with HydraParticipant. Uses the project's `encrypt()`/`decrypt()` utilities.
- **HydraSnapshot**: A confirmed snapshot within a Hydra head. Records snapshot number, UTXO hash, and optional fanout transaction hash after the head closes. Used for L2→L1 reconciliation.
- **Transaction (extended)**: The existing Transaction model, extended with a `layer` field (L1/L2) and an optional `hydraHeadId` foreign key to track which head processed L2 transactions.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: When an open Hydra head exists between two participants, transactions between them are confirmed in under 2 seconds (vs. ~20 seconds on L1).
- **SC-002**: Transactions routed to L2 incur zero Cardano transaction fees for the participants (fees are only paid during head open/close/fanout on L1).
- **SC-003**: When Hydra is disabled or no open head exists, existing L1 behavior is completely unchanged — no performance degradation and no additional database queries.
- **SC-004**: The routing decision adds less than 50ms of overhead to each transaction submission (database lookup + routing logic).
- **SC-005**: All seven payment contract transaction types (LockFunds, SubmitResult, RequestRefund, CancelRefund, AuthorizeRefund, CollectPayment, CollectRefund) can be successfully routed through L2 when a head is available.
- **SC-006**: After a Hydra head fans out, 100% of L2 transactions processed through that head are reconciled with the resulting L1 state.
- **SC-007**: Concurrent requests for the same Hydra head instance never create duplicate instances or connection race conditions.
- **SC-008**: No unencrypted secret key material (fund wallet SK, node wallet SK, Hydra SK) is ever stored in the database or logged.

### Constitution Alignment

*Verify the feature spec addresses these constitution principles:*

- [x] **Code Quality**: Strict TypeScript, BigInt for monetary values, project patterns. The implementation uses TypeScript throughout, follows the project's service/utility pattern, and uses `async-mutex` for concurrency control.
- [x] **Testing**: Critical paths have unit + integration tests planned. The routing decision logic, head finder, instance caching, and reconciliation are all independently testable.
- [x] **UX Consistency**: Consistent API responses, frontend states handled, OpenAPI docs. The router returns a uniform result shape regardless of layer; handlers are unaffected.
- [x] **Performance**: Response time targets met, DB indexed, blockchain retries configured. HydraRelation has composite unique indexes for fast lookup; head status is indexed for efficient queries.
- [x] **Security**: Secrets encrypted, endpoints authenticated, inputs validated. All Hydra key material is encrypted at rest via HydraSecret; the router runs within the existing authenticated endpoint flow.
