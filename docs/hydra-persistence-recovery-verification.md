# Hydra persistence loss: live fund-recovery verification and snapshot-storage design

Date: 2026-08-25. Network: preprod, real hydra-node 2.3.0-ef833d8a (aarch64-darwin), Blockfrost chain backend, isolated seeded Postgres on :5433. Worktree: `verify/hydra-persistence-recovery` (based on origin/dev 9dbc17a7). All claims below are tagged VERIFIED (ran it, saw the output), REPORTED (a source said so), or INFERRED (reasoned from evidence).

## Questions and answers

**Q1. One head is open. The head node keys were exported via the API. The payment-node wallet is saved. The hydra-node persistence gets deleted. Can all funds still be withdrawn?**

Yes, proven live, with one qualification.

- One side wiped, peer intact (head 1, `863b05ef…`): full recovery at the latest snapshot. VERIFIED. The intact peer closed at snapshot n=4 and the fanout paid every party (buyer 40, seller 20, purchasing 105.78 + 250).
- BOTH sides wiped (head 3, `9e137dd3…`): full recovery of all funds, and even full resumption of the head. VERIFIED end to end. Chain replay alone rebuilt the last increment's signed snapshot, normal L2 operation resumed, and close plus fanout paid everyone. Qualification: L2 transactions signed AFTER the last on-chain increment roll back. They survive only if both parties cooperate and re-sign them, which we did live.

**Q2. What does the masumi node DB store? Is DB + ENCRYPTION_KEY enough to recover everything?**

The DB stores every key: encrypted wallet mnemonics, the hydra signing key, the node cardano key, remote party verification keys, and head identity fields. VERIFIED by decrypting and re-deriving addresses (`96-derive-db-wallets.mts`). At the time of this drill, it stored NO snapshot bodies, NO multisignatures, NO in-head UTxO set, and no `--start-chain-from` anchor. DB + ENCRYPTION_KEY recovered keys and wallets, and chain replay recovered state up to the last increment. It did not recover post-increment L2 state.

Correction on 2026-10-27. VERIFIED in `prisma/models/hydra-head.prisma:127-128`: the current `HydraHead` model stores `initChainSlot` and `initChainHash` as the block point before Init. `src/lib/hydra/hydra/head-init-validation.ts:336-379` resolves the point on a best-effort basis. `src/services/hydra-init-backfill/index.ts:27-61` retries missing anchors for eligible live heads. A null anchor still needs operator investigation.

Correction to the correction. An earlier version of the paragraph above also said that signed snapshot bodies, multisignatures, and the in-head UTxO set remain absent from the payment DB. That sentence was later removed from the paragraph. It was wrong for this release: it was written before the snapshot store merged. VERIFIED in `prisma/models/hydra-stored-snapshot.prisma`: `HydraStoredSnapshot` stores each verified signed snapshot with its multisignature and UTxO partitions. See `docs/hydra-snapshot-evidence.md` for what the rows attest.

**Q3. Should we store snapshots in the payment DB after each L1 hash and head change?**

Yes. The live results narrow WHY: chain replay recovers more than expected (the last increment's certificate, with signatures), so the stored snapshot matters for the L2 tail after that increment, a future unilateral close path at the true latest state, and fanout proof material. The current DB stores the replay anchor separately. An external close builder is still needed because stock hydra-node rejected sideload in this drill. Design in the second half of this document.

## Method

- Fresh worktree on origin/dev, isolated `.env` (test DB on :5433, own ENCRYPTION_KEY, Blockfrost preprod key from the main clone `.env`).
- Real two-party hydra-node pair (purchasing = node1 :4001, selling = node2 :4002), contestation 220s, dedicated persistence dirs, Blockfrost backend. No local cardano-node.
- Harness scripts in `hydra-l2-flow/`: `93-deposit.mts` (single deposit, node-side confirmation), `94-l2-spend.mts` (L2 spend from an explicitly named UTxO), `95-capture-head-state.sh` (snapshot/UTxO/head captures), `96-derive-db-wallets.mts` (DB + key → addresses), `97-restart-node.sh` (restart one node, optional `--wipe`, optional `--from SLOT.HASH`), `98-verify-l1.sh` (Blockfrost balances), `99-ws-command.mts` (raw WS client input).
- "Wipe" = `mv` of the whole persistence dir (SQLite event store + etcd raft state). Archives kept as escape hatches; none were needed.

## Verified findings

### A. One-side wipe (head 1, version 2, snapshot n=4)

1. VERIFIED. A wiped node cannot boot next to an intact peer by default: etcd fails with `member 15b56a3725607023 has already been bootstrapped`. Remedy: `ETCD_INITIAL_CLUSTER_STATE=existing`.
2. VERIFIED. A wiped node without `--start-chain-from` is blind: `Idle`, empty `/snapshot`. An open head holding 415.78 ADA was invisible to it.
3. VERIFIED. With `--start-chain-from <pre-init point>` the node replays to `Open` at the correct on-chain version.
4. VERIFIED. The intact peer alone recovers everything: it closed at n=4 and fanout `daa81085…` paid buyer 40, seller 20, purchasing 105.781012 + 250 (the acknowledged pending deposit was absorbed into the close). The wiped node followed the close on chain to `Idle` without contesting.

### B. Both-sides wipe (head 3, version 2, masumi shape: empty open + 2 deposits)

Setup: head opened with empty commits, deposits 105.781012 and 250 absorbed (version 2), one L2 payment (buyer 30) signed as ConfirmedSnapshot n=3 v2 and captured to disk. Then BOTH persistence dirs were wiped and both nodes restarted with `--start-chain-from 132000805.c62243db…` (the captured pre-init anchor).

5. VERIFIED. Replay reconstructs the last increment's certificate from chain data alone. Both nodes reached `Open` version 2 with `confirmedSnapshot = ConfirmedSnapshot n=2 v=1`, `utxo = {74a03dce…#0 = 105.781012}`, `utxoToCommit = {776d57c7…#0 = 250}`, and BOTH multisignatures present (recovered from the IncrementTx redeemer). `localUTxO` on both nodes held both UTxOs. Only the post-increment L2 tx (n=3) rolled back.
6. VERIFIED (decisive). Normal L2 operation resumes. A NewTx spending the replayed UTxO was accepted; both nodes signed a fresh `ConfirmedSnapshot n=3 v=2` (buyer 30, change 75.781012, the alpha-250 absorbed; 2 signatures). The head was fully live with zero persistence carried over.
7. VERIFIED. Close and fanout work from the recovered state. Close landed at snapshot n=3, neither node contested (both agreed), fanout `25498000…` finalized the head. L1 final: buyer 70 total (40 from head 1 + 30 from the re-signed post-recovery payment), seller 20, purchasing 873.043147. Zero funds lost.
8. VERIFIED. Sideload of the STORED newer snapshot (n=3 v2, captured pre-wipe) into the replayed node is rejected: `{"lastSeenSv":1,"requestedSv":2,"tag":"SideLoadSvNumberInvalid"}`. Same guard rejected it on head 1 with `lastSeenSv:0`. Root cause (code, tag 2.3.0): `onOpenClientSideLoadSnapshot` compares the requested snapshot version against the CONFIRMED snapshot's version, which after replay is the reconstructed older one. Upstream gap: stock hydra-node gives no way to inject a stored newer signed snapshot.
9. INFERRED (code-anchored, both live close paths consistent with it). Without any post-replay cooperation, a both-wiped pair can still close unilaterally at the reconstructed n=2 certificate via the CloseUsed path (snapshot version = open version − 1 with alpha), fanning out utxo ∪ utxoToCommit = all 355.78. We chose the richer test (resume, then close at n=3) instead of burning the head on this variant.

### C. Deposit lifecycle hazards (head 2, `b1de342f…`, sacrificed)

10. VERIFIED (code). Deposit deadline = now + 3 × depositPeriod (`HTTPServer.hs:299`). The protocol activation window is `[created + period, deadline − period]` in CHAIN-observation time (`HeadLogic.hs:874`). With Blockfrost the follower lags minutes, so a 300s period can miss the window entirely: the deposit lands on L1 but never activates. Use 600s or more for Blockfrost-backed nodes; masumi's production deposit period should be reviewed against worst-case provider lag.
11. VERIFIED. Expired deposits are fully recoverable: `DELETE /commits/<txid>`, retried until the follower tip passes the deadline slot, returned 250 and 105.78 in full. A recover posted ~60s before the deadline slot fails with a PostTxError and must be retried.
12. VERIFIED (live + code). Recovering a deposit that a signed snapshot already ACKNOWLEDGED wedges an empty head permanently. The confirmed snapshot keeps the recovered deposit in `utxoToCommit`; `selectNextDeposit` (`HeadLogic.hs:1604`) admits a new deposit only when that field is empty; clearing it needs a NewTx snapshot, which an empty head cannot produce. Head 2 was abandoned in this state. Worse, closing such a head with the poisoned snapshot commits to an alpha that no longer exists on L1, which makes fanout unsatisfiable. Upstream issue material. Operational rule for masumi: never recover a deposit that a snapshot has acknowledged unless a later snapshot has already cleared it, or the head still has L2 funds to force that snapshot. **Corrected 2026-10-22:** for hydra-node 2.4.1 the recovery is not what leaves the deposit in `utxoToCommit`, and closing such a head does not make fanout unsatisfiable. See findings 15 to 18.
13. VERIFIED. `GET /commits` (chain-level pending deposits) is the authoritative deposit-observation signal and survives restarts from persistence. Blockfrost tx-query endpoints lag several minutes behind submission; a resubmission that fails with `BadInputsUTxO` of your own input means the tx already landed.
14. VERIFIED. A node rejects `Init` sent right after boot (`RejectedInputBecauseUnsynced`, drift 0) until the follower observes its first block.

### D. Finding 12 re-checked against hydra-node 2.4.1 (2026-10-22)

Method: code reading of the upstream 2.4.1 tag, which `packages/hydra-host/Dockerfile` pins. Sources: `hydra-node/src/Hydra/HeadLogic.hs` (byte-identical to the tag, checked with `cmp`), `hydra-plutus/src/Hydra/Contract/Head.hs` and `hydra-plutus/validators/deposit.ak`. Nothing in this section was reproduced live. Line numbers refer to the 2.4.1 files.

15. VERIFIED (code). A recovery cannot race an increment. `deposit.ak` lets an increment claim a deposit only while the transaction's upper bound is at or before the deadline, and lets a recovery spend it only once the lower bound is after the deadline. So the state finding 12 describes, a confirmed snapshot whose `utxoToCommit` holds a deposit that was never incremented, exists as soon as the deadline passes with the increment not landed. It exists whether or not anyone recovers the deposit. The recovery in head 2 did not create it. The node posts an `IncrementTx` each time a snapshot that holds the deposit confirms (`maybePostIncrementTx`, `HeadLogic.hs:607`), and again after a chain rollback (`maybeRepostIncrementTx`). A transaction snapshot carries the deposit again while it is still active (`selectNextDeposit`, `HeadLogic.hs:1963`, and `HeadLogic.hs:442-443`), so short of a chain rollback, a failed post is retried only if an L2 transaction confirms before the deposit expires, one deposit period before its deadline. In an empty head, one failed post is enough.
16. VERIFIED (code). Closing such a head does not make fanout unsatisfiable in 2.4.1. The fanout validator checks that the outputs are a subset of the closed accumulator and that their value equals the head's value (`Head.hs:600-648`). The node leaves a pending commit out of the fanout when the snapshot's version equals the on-chain version, which is the case when its increment never landed (`effectiveCommitDecommit`, `HeadLogic.hs:1458`). The last claim of finding 12 was wrong for 2.4.1. Why the earlier method missed it: finding 12 read the 2.3.0 code, which this section did not re-check, and head 2 was abandoned without a close, so no close was tried live.
17. VERIFIED (code) for each step, INFERRED for the combined outcome. What a recovery does change: every node that signed the deposit's snapshot records it as the deposit in flight (`currentDepositTxId`). Each requested snapshot sets that record to its own deposit, or to none (`HeadLogic.hs:2616`). `DepositActivated` sets it only while it is empty (`HeadLogic.hs:2703`). `CommitFinalized`, `DepositRecovered` and `LocalStateCleared` clear it; the last one comes with every side-load of a confirmed snapshot (`HeadLogic.hs:2690`).
    - Not recovered: the chain tick starts a deposit snapshot only while the record is empty (`HeadLogic.hs:1006`), so later deposits wait. A snapshot for any L2 transaction carries no deposit, because `selectNextDeposit` (`HeadLogic.hs:1963-1966`) skips the expired deposit and starts no new one while the confirmed snapshot holds a commit. That snapshot clears `utxoToCommit` and the record, and deposits flow again. A head with no L2 funds cannot make that transaction.
    - Recovered: `DepositRecovered` clears the record (`HeadLogic.hs:2386-2392`). The next active deposit can then make the leader request a snapshot that every node rejects with `ReqSnCommitNotSettled` while the confirmed snapshot still holds the old commit (`HeadLogic.hs:437-444`). The leader stays in `RequestedSnapshot`, and neither a transaction (`HeadLogic.hs:252`) nor the tick (`HeadLogic.hs:1007`) starts a snapshot while one is in flight. That also blocks the L2 transaction way out. The stall needs one more active deposit before a transaction snapshot clears the commit. A deposit already queued behind this one can stall the leader at the next tick, because the tick picks the oldest active non-empty deposit (`HeadLogic.hs:1022-1027`). A new one can be enough too: the tick that activates it decides on the state from before its own events (`HeadLogic.hs:2123-2124`).
    - So the operational rule of finding 12 stands for open heads, for this narrower reason, but its last clause is wrong: an open head with L2 funds should first confirm a transaction that clears the commit, and only then recover the deposit. An empty head can close first, then recover.
18. INFERRED (code). The payment service's guard reads only its own node's confirmed snapshot and the round its own node signed. A peer can hold a confirmed snapshot that this node does not see only after this node lost a round it signed. Verdict per trigger:
    - Snapshot-round reset (`src/services/hydra-snapshot-round/reset.ts`) and hydra-host `unwedge` both side-load this node's own confirmed snapshot. If the peer already confirmed the lost round, the two nodes disagree on the last snapshot number, and `requireReqSn` (`HeadLogic.hs:399`) rejects every later request on one side. The head is forked before any recovery, and a close with a contest is the way out whether or not the deposit is recovered. A recovery adds no harm. Separately, the side-load clears the deposit-in-flight record (finding 17), so on a head whose confirmed snapshot holds a commit that can no longer land, a reset has the same effect on the reset node as a recovery. That is a hazard of the reset itself, which this guard does not cover. **Updated 2026-10-22:** the reset and `unwedge` now have their own guard. Each reads `GET /head` and refuses while the confirmed snapshot holds `utxoToCommit` and the head version still equals the snapshot version. The reset answers 409 (`reset.ts` `assertCommitSettled`). `unwedge` returns `Held` (`unwedge.ts` `holdsUnsettledCommit`): it leaves the round stranded and keeps the node `Running`, so its API stays open. After a reset, the reset node, when it leads, can request a snapshot with a different deposit, which every node rejects (`HeadLogic.hs:437-444`). Whether that happens depends on the state of the pending deposits and on which node leads. The node's HTTP API does not report a deposit's status (`GET /head` returns `headState` only, `HTTPServer.hs:341-342`, and `GET /commits` returns txids), so the guard cannot tell a safe case from one that stalls and refuses every case. A head whose `GET /head` answer the payment service cannot use, such as one over the byte limit, resets without the check. VERIFIED by unit tests only, each checked by reverting its source: the 409 and 502 reset cases, the two `unwedgeNode` guard cases, the `Held` record case and the shutdown check fail on the reverted code. The byte-limit case passes either way, by design. Corrections: ee9a6853 said every new case fails without the guard, but the byte-limit case passes either way. Five later versions (623ae901, 5e136947, 1a7d0fcb, 5bc0764ec and 9e97dd8d2) described when a reset stalls or is safe, and each got at least one case wrong, such as an older active deposit, an empty deposit, or a transaction snapshot that drops the commit first. From 623ae901 on they also said that ee9a6853 implied every unsettled deposit stalls a reset, which it did not. This version claims only that a reset can stall the head.
    - Correction 2026-10-26 (VERIFIED by code and regression tests): The earlier sentence that an oversized `GET /head` response allows reset without a deposit check described an unsafe exception. The reset now returns 502 on an unreadable or malformed response. Host `unwedge` holds the round when the response is malformed. The old test proved only that the exception existed; it did not prove that side-loading was safe. INFERRED: A large head can lose this admin reset route and need another operator recovery path, such as close and contest.
    - Persistence restore: a replayed or older node lags the peer's confirmed snapshot and cannot side-load it, because a side-load needs an equal `utxoToCommit` (`SideLoadUTxOToCommitInvalid`, `HeadLogic.hs:1363`). Same fork, same verdict.
    - Close: a closed head confirms no snapshots, and fanout leaves out a commit that never landed (finding 16). A recovery is safe, so the payment service skips the guard for a head whose recorded status is Closed or later.

## What the DB stores: drill and current schema

- Encrypted with ENCRYPTION_KEY: `WalletSecret.encryptedMnemonic` (fund wallets), `HydraSecretKey` (hydra SK + node cardano SK), HydraHost tokens.
- Plain at the time of the drill: `headIdentifier`, `contestationPeriod`, remote party vkeys (`HydraVerificationKey`), advertise fields, `latestSnapshotNumber` (bare counter), reconciliation cursors.
- VERIFIED current schema: `HydraHead.initChainSlot` and `HydraHead.initChainHash` can store the pre-Init replay anchor. Both fields are nullable. Anchor observation and backfill are best effort, so inspect each Head before a restore.
- VERIFIED current schema: `HydraStoredSnapshot` stores each verified signed snapshot body, its multisignature, and its UTxO partitions.
- Absent from the current payment DB: the node event log.

## Feature design: snapshot storage in the payment DB

### What to store

One append-only table with one row per confirmed snapshot. The current schema
already has nullable anchor columns on each `HydraHead` row.

```prisma
model HydraStoredSnapshot {
  id              String   @id @default(cuid())
  createdAt       DateTime @default(now())
  hydraHeadId     String   // FK -> HydraHead
  headIdentifier  String   // on-chain headId hex, denormalized for recovery without joins
  snapshotNumber  Int
  snapshotVersion Int
  snapshotJson    Json     // full /snapshot response: snapshot body incl. utxo,
                           // utxoToCommit, utxoToDecommit, AND signatures.multiSignature
  utxoHash        String   // canonical hash for integrity checking on read-back
  kind            HydraSnapshotKind // CONFIRMED | INCREMENT_ACK | DECREMENT_ACK
  @@unique([hydraHeadId, snapshotNumber, snapshotVersion])
  @@index([hydraHeadId, snapshotNumber(sort: Desc)])
}

// Implemented on HydraHead as initChainSlot and initChainHash:
// nullable slot and hash of the block before the observed InitTx.
```

Write triggers, in the existing L2 sync path (the service already receives and verifies every `SnapshotConfirmed`; `VerifiedHydraSnapshot` already carries canonical TxOut bytes):

1. After every verified `SnapshotConfirmed`: upsert the row. This covers the user's "after each head change".
2. After every observed L1 head transition (increment, decrement, close, contest): re-assert that the latest stored row is the one the transition references, and mark `kind`. This covers "after each L1 hash".
3. Existing code: when it verifies InitTx on chain, record the parent block point in `HydraHead.initChainSlot` and `initChainHash` when available. The scheduled backfill retries a missing point for eligible live Heads. Check that both fields are set before a replay-based restore.

Retention: keep at least the latest CONFIRMED row, the latest INCREMENT_ACK row per version, and every row not yet superseded by an on-chain transition. Older rows can be pruned; append-only until a pruning job exists is fine at masumi volumes.

### Recovery runbooks the stored data enables

R1. Peer intact (today's common case). Nothing needed from the store: the peer closes at the latest snapshot. VERIFIED live (head 1).

R2. Both sides wiped, counterparty cooperative. Restart both nodes with `--wipe`-equivalent fresh dirs and `--start-chain-from` = the verified anchor. Replay rebuilds the last increment certificate (VERIFIED, finding 5). The stored `HydraStoredSnapshot.signedSnapshotJson` rows can identify the rolled-back L2 tail (diff stored latest utxo vs reconstructed utxo). Re-submit those transactions. After re-signing, close and fan out normally (VERIFIED, findings 6 and 7).

R3. Both sides wiped, counterparty gone or hostile. Stock node closes at the reconstructed last-increment state (INFERRED, finding 9), which already recovers ALL funds at their positions as of the last increment. To close at the true latest state instead, build the close tx externally from the stored snapshot: the row holds the snapshot body and both multisignatures; the accumulator commitment is recomputable from the stored canonical TxOut bytes (the service already has the KZG code); the head validator is a published reference script. This is the only path that needs new tx-building code, and it is needed only when the rolled-back tail materially favors the counterparty.

R4. Mid-fanout crash (multi-step fanout). Partial fanout (hydra 2.2+) drains a closed head over several `PartialFanoutTx` steps plus a `FinalPartialFanoutTx`. Driver liveness is open: any party can resume the drain, and the proofs are membership proofs against the closed commitment. The stored snapshot's full UTxO contents are exactly the proof material needed to resume from any intermediate state, even with zero node persistence. Not triggered live here (3 outputs → single fanout); code-verified. The store must therefore keep the FULL utxo map, not a hash.

R5. Pending-deposit cleanup after recovery. The stored row's `utxoToCommit` plus `GET /commits` decide, per deposit: absorbed on chain (nothing to do), acknowledged but not incremented (do NOT recover it while it sits in the alpha of an open head's latest snapshot; clear it first with any L2 transaction, or close an empty head; see findings 12 and 17), or unacknowledged/expired (recover via `DELETE /commits/<txid>` after the deadline; VERIFIED, finding 11).

### Upstream issues worth filing

1. Sideload guard: `POST /snapshot` cannot inject a stored newer signed snapshot into a replayed node (`SideLoadSvNumberInvalid`, findings 4/8). If upstream relaxed the guard to accept a strictly newer snapshot valid at the current open version, R3 would need no external builder.
2. Recover-after-acknowledge wedge (findings 12 and 17): `DepositRecovered` clears `currentDepositTxId` while the confirmed snapshot still holds the commit, and a failed `IncrementTx` is retried only when another snapshot carries the deposit or the chain rolls back (finding 15). The unfanoutable close does not hold in 2.4.1 (finding 16).
3. Deposit activation window vs slow chain followers (finding 10): the node could refuse to draft a deposit whose window its own follower lag will miss.

## Operational notes for masumi

- Set the hydra-node deposit period to at least 600s wherever Blockfrost (or any remote provider) backs the node.
- Record the pre-init chain point at head creation time. It is a two-column change with outsized recovery value.
- Treat `GET /commits` as the deposit source of truth in reconcilers; never key resubmission decisions off Blockfrost tx-query visibility.
- Never auto-recover a deposit that an open head's snapshot has acknowledged (finding 12 guard, narrowed by findings 16 to 18).
- While the confirmed snapshot holds a deposit that the chain has not settled, a round reset is refused, and `unwedge` leaves the round stranded with the node running (finding 18). Wait until the head absorbs the deposit, then reset the round from the payment service. If the deposit passes its deadline first, close the head.

## Least confident decisions

1. Finding 9 (unilateral CloseUsed at the reconstructed n=2 certificate) is INFERRED from the validator rules plus the reconstructed state's shape; we closed at n=3 instead of spending a head to prove it. Cheap to prove later with a throwaway head.
2. The claim that increment redeemers always carry recoverable multisignatures is generalized from one hydra version (2.3.0). A hydra upgrade could change what replay reconstructs; the storage design intentionally does not depend on it.
3. Multi-step fanout resumability (R4) is code-verified only. A live partial-fanout drill (a head with enough UTxOs to force chunking, killed mid-drain) would close the gap.
4. The Prisma sketch stores full snapshot JSON per row. If heads ever hold hundreds of UTxOs, row size and write amplification may need the pruning job sooner than assumed.
5. The 600s deposit-period floor is calibrated to the lag observed in this session (roughly 2 to 8 minutes). Worse provider conditions may need more, or the drafting-side guard from upstream issue 3.
6. Findings 15 to 18 are code reading of 2.4.1 only. The `RequestedSnapshot` stall in finding 17 and the forks in finding 18 were not reproduced live. A throwaway preprod head with a deposit whose increment misses its deadline would settle finding 17.
