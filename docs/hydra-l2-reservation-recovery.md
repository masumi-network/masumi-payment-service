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

## Safe manual release — only after ALL of the following hold

1. The head's ordered replay is **healthy** (`reconciliationStalledTxId IS NULL`)
   and `Node.confirmedTransactionHistoryReady` was reached (the hourly expired-
   reservation warning only fires after an authenticated full history pass).
2. The signed validity bound has **provably passed**: the current head chain
   time (latest Tick) is past `Transaction.invalidHereafterSlot`'s slot-end
   time. After this point the head's ledger can no longer accept the body.
3. The `intendedTxHash` appears **nowhere** in the head's confirmed history and
   is not a live in-head UTxO producer (check the admin Hydra page / node
   `GET /snapshot/utxo`).

Then, in one transaction:

```sql
BEGIN;
-- Roll the reservation back (adjust ids). l2Reservation* columns on the
-- Transaction row record the exact pre-reservation state to restore.
UPDATE "Transaction" SET status = 'FailedViaTimeout' WHERE id = '<tx-id>' AND status = 'Pending';
UPDATE "HotWallet"   SET "lockedAt" = NULL, "pendingTransactionId" = NULL WHERE id = '<wallet-id>';
-- Restore the purchase request to retryable state (see the Transaction row's
-- l2ReservationPreviousActionId / l2ReservationPreviousTransactionId /
-- l2ReservationPreviousLayer columns for the exact prior wiring).
COMMIT;
```

If the paired PaymentRequest was stamped by the reservation
(`l2ReservationPeerPreviousLayer` is set), restore its `layer` from that column
and disconnect its `CurrentTransaction` in the same transaction.

## Do NOT

- Release a reservation while the head is still within the signed validity
  window — the body can still land.
- Delete the Transaction row — it is the only durable record of the signed
  body's identity (`intendedTxHash`) and of the pre-reservation state.
- "Fix" this by removing the fail-closed retention in
  `l2-lock.ts` / `l2-reservation-recovery.ts`. A future snapshot-bound absence
  proof (explicit takeover protocol) is the planned automated release.
