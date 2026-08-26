# Hydra persistence loss: live fund-recovery verification and snapshot-storage design

Date: 2026-08-25. Network: preprod, real hydra-node 2.3.0-ef833d8a (aarch64-darwin), Blockfrost chain backend, isolated seeded Postgres on :5433. Worktree: `verify/hydra-persistence-recovery` (based on origin/dev 9dbc17a7). All claims below are tagged VERIFIED (ran it, saw the output), REPORTED (a source said so), or INFERRED (reasoned from evidence).

## Questions and answers

**Q1. One head is open. The head node keys were exported via the API. The payment-node wallet is saved. The hydra-node persistence gets deleted. Can all funds still be withdrawn?**

Yes, proven live, with one qualification.

- One side wiped, peer intact (head 1, `863b05ef…`): full recovery at the latest snapshot. VERIFIED. The intact peer closed at snapshot n=4 and the fanout paid every party (buyer 40, seller 20, purchasing 105.78 + 250).
- BOTH sides wiped (head 3, `9e137dd3…`): full recovery of all funds, and even full resumption of the head. VERIFIED end to end. Chain replay alone rebuilt the last increment's signed snapshot, normal L2 operation resumed, and close plus fanout paid everyone. Qualification: L2 transactions signed AFTER the last on-chain increment roll back. They survive only if both parties cooperate and re-sign them, which we did live.

**Q2. What does the masumi node DB store? Is DB + ENCRYPTION_KEY enough to recover everything?**

The DB stores every key: encrypted wallet mnemonics, the hydra signing key, the node cardano key, remote party verification keys, and head identity fields. VERIFIED by decrypting and re-deriving addresses (`96-derive-db-wallets.mts`). It stores NO snapshot bodies, NO multisignatures, and NO in-head UTxO set (`latestSnapshotNumber` is a bare counter). So DB + ENCRYPTION_KEY recovers keys and wallets, and (given the chain) everything up to the last increment. It does not recover post-increment L2 state, and it does not record the chain anchor needed for `--start-chain-from`. The snapshot-storage feature below closes both gaps.

**Q3. Should we store snapshots in the payment DB after each L1 hash and head change?**

Yes. The live results narrow WHY: chain replay recovers more than expected (the last increment's certificate, with signatures), so the stored snapshot matters for exactly three things: (1) the L2 tail after the last increment, which is the part a counterparty who benefits from the rollback will refuse to re-sign; (2) a future unilateral close path at the true latest state (needs an external close builder, because sideload is rejected upstream); (3) the replay anchor and fanout proof material. Design in the second half of this document.

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
12. VERIFIED (live + code). Recovering a deposit that a signed snapshot already ACKNOWLEDGED wedges an empty head permanently. The confirmed snapshot keeps the recovered deposit in `utxoToCommit`; `selectNextDeposit` (`HeadLogic.hs:1604`) admits a new deposit only when that field is empty; clearing it needs a NewTx snapshot, which an empty head cannot produce. Head 2 was abandoned in this state. Worse, closing such a head with the poisoned snapshot commits to an alpha that no longer exists on L1, which makes fanout unsatisfiable. Upstream issue material. Operational rule for masumi: never recover a deposit that a snapshot has acknowledged unless a later snapshot has already cleared it, or the head still has L2 funds to force that snapshot.
13. VERIFIED. `GET /commits` (chain-level pending deposits) is the authoritative deposit-observation signal and survives restarts from persistence. Blockfrost tx-query endpoints lag several minutes behind submission; a resubmission that fails with `BadInputsUTxO` of your own input means the tx already landed.
14. VERIFIED. A node rejects `Init` sent right after boot (`RejectedInputBecauseUnsynced`, drift 0) until the follower observes its first block.

## What the DB stores today (origin/dev schema)

- Encrypted with ENCRYPTION_KEY: `WalletSecret.encryptedMnemonic` (fund wallets), `HydraSecretKey` (hydra SK + node cardano SK), HydraHost tokens.
- Plain: `headIdentifier`, `contestationPeriod`, remote party vkeys (`HydraVerificationKey`), advertise fields, `latestSnapshotNumber` (bare counter), reconciliation cursors.
- Absent: signed snapshot bodies, multisignatures, in-head UTxO sets, the event log, and any chain anchor for `--start-chain-from`.

## Feature design: snapshot storage in the payment DB

### What to store

One append-only table, one row per confirmed snapshot, plus one anchor row per head.

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

// On HydraHead (new columns):
//   initTxChainSlot  BigInt?  // slot of the block BEFORE the observed InitTx
//   initTxChainHash  String?  // its block hash -> the --start-chain-from anchor
```

Write triggers, in the existing L2 sync path (the service already receives and verifies every `SnapshotConfirmed`; `VerifiedHydraSnapshot` already carries canonical TxOut bytes):

1. After every verified `SnapshotConfirmed`: upsert the row. This covers the user's "after each head change".
2. After every observed L1 head transition (increment, decrement, close, contest): re-assert that the latest stored row is the one the transition references, and mark `kind`. This covers "after each L1 hash".
3. On head creation: store the pre-init chain point (slot + hash of the tip just before posting InitTx) on the head row. Without this anchor, replay-based recovery cannot start.

Retention: keep at least the latest CONFIRMED row, the latest INCREMENT_ACK row per version, and every row not yet superseded by an on-chain transition. Older rows can be pruned; append-only until a pruning job exists is fine at masumi volumes.

### Recovery runbooks the stored data enables

R1. Peer intact (today's common case). Nothing needed from the store: the peer closes at the latest snapshot. VERIFIED live (head 1).

R2. Both sides wiped, counterparty cooperative. Restart both nodes with `--wipe`-equivalent fresh dirs and `--start-chain-from` = stored anchor. Replay rebuilds the last increment certificate (VERIFIED, finding 5). Re-submit the rolled-back L2 tail: the stored `snapshotJson` rows tell you exactly which txs are missing (diff stored latest utxo vs reconstructed utxo). After re-signing, close and fan out normally (VERIFIED, findings 6 and 7).

R3. Both sides wiped, counterparty gone or hostile. Stock node closes at the reconstructed last-increment state (INFERRED, finding 9), which already recovers ALL funds at their positions as of the last increment. To close at the true latest state instead, build the close tx externally from the stored snapshot: the row holds the snapshot body and both multisignatures; the accumulator commitment is recomputable from the stored canonical TxOut bytes (the service already has the KZG code); the head validator is a published reference script. This is the only path that needs new tx-building code, and it is needed only when the rolled-back tail materially favors the counterparty.

R4. Mid-fanout crash (multi-step fanout). Partial fanout (hydra 2.2+) drains a closed head over several `PartialFanoutTx` steps plus a `FinalPartialFanoutTx`. Driver liveness is open: any party can resume the drain, and the proofs are membership proofs against the closed commitment. The stored snapshot's full UTxO contents are exactly the proof material needed to resume from any intermediate state, even with zero node persistence. Not triggered live here (3 outputs → single fanout); code-verified. The store must therefore keep the FULL utxo map, not a hash.

R5. Pending-deposit cleanup after recovery. The stored row's `utxoToCommit` plus `GET /commits` decide, per deposit: absorbed on chain (nothing to do), acknowledged but not incremented (do NOT recover it while it sits in the latest snapshot's alpha; see finding 12), or unacknowledged/expired (recover via `DELETE /commits/<txid>` after the deadline; VERIFIED, finding 11).

### Upstream issues worth filing

1. Sideload guard: `POST /snapshot` cannot inject a stored newer signed snapshot into a replayed node (`SideLoadSvNumberInvalid`, findings 4/8). If upstream relaxed the guard to accept a strictly newer snapshot valid at the current open version, R3 would need no external builder.
2. Recover-after-acknowledge wedge and unfanoutable close (finding 12).
3. Deposit activation window vs slow chain followers (finding 10): the node could refuse to draft a deposit whose window its own follower lag will miss.

## Operational notes for masumi

- Set the hydra-node deposit period to at least 600s wherever Blockfrost (or any remote provider) backs the node.
- Record the pre-init chain point at head creation time. It is a two-column change with outsized recovery value.
- Treat `GET /commits` as the deposit source of truth in reconcilers; never key resubmission decisions off Blockfrost tx-query visibility.
- Never auto-recover an acknowledged deposit (finding 12 guard).

## Least confident decisions

1. Finding 9 (unilateral CloseUsed at the reconstructed n=2 certificate) is INFERRED from the validator rules plus the reconstructed state's shape; we closed at n=3 instead of spending a head to prove it. Cheap to prove later with a throwaway head.
2. The claim that increment redeemers always carry recoverable multisignatures is generalized from one hydra version (2.3.0). A hydra upgrade could change what replay reconstructs; the storage design intentionally does not depend on it.
3. Multi-step fanout resumability (R4) is code-verified only. A live partial-fanout drill (a head with enough UTxOs to force chunking, killed mid-drain) would close the gap.
4. The Prisma sketch stores full snapshot JSON per row. If heads ever hold hundreds of UTxOs, row size and write amplification may need the pruning job sooner than assumed.
5. The 600s deposit-period floor is calibrated to the lag observed in this session (roughly 2 to 8 minutes). Worse provider conditions may need more, or the drafting-side guard from upstream issue 3.
