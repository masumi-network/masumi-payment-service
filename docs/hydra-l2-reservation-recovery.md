# Runbook: stuck Hydra L2 lock reservations (locked purchasing wallet)

## Symptom

A purchasing hot wallet stops participating in **both** L1 and L2 batching. The
wallet row has `lockedAt != null` and `pendingTransactionId != null`, the
referenced `Transaction` row is `Pending` with an `intendedTxHash` (and possibly
`txHash = null`), and the purchase request is parked in `FundsLockingInitiated`.
Logs show one of:

- `L2 funds-lock failed; reservation retained fail-closed` (submit threw)
- `L2 funds-lock accepted but txHash persistence failed; reservation retained`
- `Hydra returned divergent txHash; preserving reservation fail-closed`
- hourly `expired L2 lock reservation retained` warnings from
  `reportExpiredL2Reservations`

## Why this is fail-closed on purpose

The lock body was **signed and possibly relayed** before the failure. hydra-node
acceptance is not consensus proof, and history absence is not proof of
rejection while the tx could still appear in a signed snapshot. Auto-releasing
the reservation could double-lock the same purchase (once on L2 from the
withheld body, once on L1 from the retried request). So the service retains the
reservation and waits for signed-snapshot evidence; it never times it out on
its own.

In the normal case no action is needed: if the tx **was** accepted by the head,
the event/replay path matches it by `intendedTxHash` and confirms it; the
reservation resolves itself.

## Detection queries

```sql
-- Retained reservations older than 1 hour
SELECT t.id, t."intendedTxHash", t."txHash", t."createdAt", t."invalidHereafterSlot",
       w.id AS wallet_id, w."lockedAt"
FROM "Transaction" t
JOIN "HotWallet" w ON w."pendingTransactionId" = t.id
WHERE t.status = 'Pending' AND t.layer = 'L2'
  AND t."createdAt" < now() - interval '1 hour';
```

Also check `HydraHead.reconciliationStalledTxId` — a stalled replay can delay
the confirmation that would resolve the reservation. Resolve the stall first.

## Safe manual release: only with the automatic path's proof

Expiry, history absence and live-UTxO absence are **not** enough. A peer can
hold a snapshot our node signed before expiry and publish it later. If that
snapshot applied the body, a released and retried purchase locks twice. See
`decideL2ReservationRelease` in
`packages/payment-source-v2/src/services/hydra-reconcile/l2-reservation-release-decision.ts`.

Prefer the automatic release: it runs the proof below every reconcile pass and
marks the row with `l2ReleasedByInputProofAt`. Release by hand only when the
automatic path cannot run (for example after a restart wiped its in-memory
baseline while the head stays idle), and only when ALL of these hold:

1. The head's ordered replay is **healthy** (`reconciliationStalledTxId IS NULL`)
   and `Node.confirmedTransactionHistoryReady` was reached.
2. The signed validity bound has **provably passed**: the current head chain
   time (latest Tick) is past `Transaction.invalidHereafterSlot`'s slot-end
   time.
3. `Transaction.l2ReservationInputRefs` is not empty. Without the input refs
   there is no proof. Leave the reservation in place.
4. You have ONE of these two proofs:
   - **Post-expiry snapshot proof.** After step 2, read **our own** node's
     confirmed snapshot number `B` from `GET /snapshot` (not from replay or the
     DB, which can lag). Then wait for a confirmed snapshot `S` with
     `S.number > B` whose multi-signature verifies against the head's
     participant keys. Every ref in `l2ReservationInputRefs` must be present
     in `S`'s UTxO set. If `l2ReleaseNudgeInputRef` is set, that ref must be
     **absent** from `S` (the nudge has applied). An idle head makes no new
     snapshot: self-send an unreserved wallet UTxO in the head to produce one.
     Our node signs at most `B + 1` while the body is still valid, so `S`
     includes every snapshot that could have applied it.
   - **Final fanout proof.** The head is closed and fanned out, the fanout
     matches the verified final snapshot (`resolveVerifiedHydraFanoutReferences`
     accepts it), and every ref in `l2ReservationInputRefs` is in that final
     snapshot's UTxO set. No snapshot can follow a fanout.

   An input that is missing from the snapshot, or present only as a pending
   commit, proves nothing. Keep the reservation.

Then run the release in one serializable transaction. Fill in the values you
saw while you collected the proof. Each guard raises on mismatch, so a row that
changed after the proof (a late confirmation, an automatic release, another
operator) aborts the whole transaction instead of being overwritten.

```sql
BEGIN ISOLATION LEVEL SERIALIZABLE;
DO $$
DECLARE
  changed integer;
BEGIN
  UPDATE "Transaction"
     SET status = 'FailedViaTimeout', "l2ReleasedByInputProofAt" = now()
   WHERE id = '<tx-id>'
     AND status = 'Pending'
     AND layer = 'L2'
     AND "intendedTxHash" = '<intended-tx-hash>'
     AND "txHash" IS NOT DISTINCT FROM <tx-hash-or-NULL>
     AND "l2ReservationInputRefs" = ARRAY[<input-refs-checked-in-the-proof>]::text[]
     AND "l2ReleaseNudgeInputRef" IS NOT DISTINCT FROM <nudge-ref-or-NULL>;
  GET DIAGNOSTICS changed = ROW_COUNT;
  IF changed <> 1 THEN
    RAISE EXCEPTION 'Transaction <tx-id> no longer matches the proof';
  END IF;

  UPDATE "HotWallet"
     SET "lockedAt" = NULL, "pendingTransactionId" = NULL
   WHERE id = '<wallet-id>' AND "pendingTransactionId" = '<tx-id>';
  GET DIAGNOSTICS changed = ROW_COUNT;
  IF changed <> 1 THEN
    RAISE EXCEPTION 'Wallet <wallet-id> is not reserved by <tx-id>';
  END IF;
END $$;
-- Restore the purchase request to retryable state (see the Transaction row's
-- l2ReservationPreviousActionId / l2ReservationPreviousTransactionId /
-- l2ReservationPreviousLayer columns for the exact prior wiring). Guard each
-- request update with "currentTransactionId" = '<tx-id>' and check that it
-- changed exactly one row, as above.
COMMIT;
```

`l2ReleasedByInputProofAt` makes replay halt if the body ever confirms later.
That is an invariant breach and needs investigation, not a retry.

If the paired PaymentRequest was stamped by the reservation
(`l2ReservationPeerPreviousLayer` is set), restore its `layer` from that column
and disconnect its `CurrentTransaction` in the same transaction, with the same
`"currentTransactionId" = '<tx-id>'` guard.

## Do NOT

- Release a reservation while the head is still within the signed validity
  window. The body can still land.
- Release on expiry plus history or UTxO absence alone. A withheld snapshot
  signed before expiry can still apply the body.
- Delete the Transaction row — it is the only durable record of the signed
  body's identity (`intendedTxHash`) and of the pre-reservation state.
- "Fix" this by removing the fail-closed retention in
  `l2-lock.ts` / `l2-reservation-recovery.ts`. The input proof in
  `decideL2ReservationRelease` is the automated release.
