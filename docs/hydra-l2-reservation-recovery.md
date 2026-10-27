# Runbook: held Hydra L2 reservations

## Symptom

A purchasing hot wallet stops participating in **both** L1 and L2 batching. The
wallet row has `lockedAt != null` and `pendingTransactionId != null`, the
referenced `Transaction` row is `Pending` with an `intendedTxHash` (and possibly
`txHash = null`). An initial lock leaves the purchase in
`FundsLockingInitiated`. An action reservation can also remain held.
Logs show one of:

- `L2 funds-lock failed; reservation retained fail-closed` (submit threw)
- `L2 funds-lock accepted but txHash persistence failed; reservation retained`
- `Hydra returned divergent txHash; preserving reservation fail-closed`
- hourly `expired L2 reservations require explicit reconciliation` warnings from
  `reportExpiredL2Reservations`

## Why this is fail-closed on purpose

The lock body was **signed and possibly relayed** before the failure. hydra-node
acceptance is not consensus proof, and history absence is not proof of
rejection while the tx could still appear in a signed snapshot. Auto-releasing
the reservation could double-lock the same purchase (once on L2 from the
withheld body, once on L1 from the retried request). So the service retains the
reservation until a verified release nudge spends the reserved inputs, or
an operator accepts the risk of an unprovable release. Expiry alone never frees
the wallet.

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

## Automatic release and its proof

The recovery job requires healthy, verified Head history and a fresh Head
clock past the body's validity bound plus grace. For an initial lock with
recorded inputs and a trusted value floor, it records and submits a release
nudge that spends those inputs. It releases the reservation only when the
nudge's exact nonce-tagged output bytes appear in a verified current snapshot.
For a Final Head, it also requires that output in the verified final snapshot
and a confirmed L1 fanout. See `l2-release-nudge-proof.ts`,
`l2-reservation-recovery.ts`, and `final-l2-reservation-release.ts` in
`packages/payment-source-v2/src/services/hydra-reconcile/`.

Input references reported by a node, history absence, expiry, and a node's
rejection are not release proof. An idle Head may need time to confirm the
recorded nudge. Actions and older reservations without the required inputs or
value floor remain held for operator review. The release helper changes the
transaction to `RolledBack`, stamps `l2ReleasedByInputProofAt`, frees the
reserved wallet, and restores request state in one serializable transaction.

## Operator release when proof is unavailable

1. Check that the Head replay is healthy and that the body's validity bound
   has passed. Inspect independent participant or L1 evidence for any sign
   that the body applied. Do not treat absence from one node as proof.
2. Call `GET /api/v1/hydra/head/l2-reservations?headId=<head-id>`. Inspect
   `releasable`, `blockedReason`, `updatedAt`, the intended hash, and the
   recorded nudge. Resolve a blocked reason before proceeding.
3. If release is still necessary, call
   `POST /api/v1/hydra/head/l2-reservations/release` with `headId`,
   `transactionId`, `expectedUpdatedAt` from step 2, and
   `acknowledgeUnprovable: true`. The server rechecks the row and live Head
   evidence and may refuse the release. A closed or Final Head cannot use
   this endpoint.

This is an operator risk decision, **not proof that the body never applied**.
The admin route stamps `l2ReleasedByOperatorAt` and restores wallet and request
state atomically. If the body later confirms, replay stops with
`reconciliationStalledReason = 'replay-apply-retry'` for investigation. Do not
change the database rows by hand.

Correction: this section used to call every such confirmation an invariant
breach that needs investigation. That is true for a nudge-proof release and
for an initial lock. It was too strict for an admin release of an action. The
admin release cannot prove the body dead, so the body can still confirm (the
mainnet incident of 2026-10-22 on head `f6ec7beb…a7622cae`, withdraw
`35f9b589…`). Then the escrow output it spends is gone, no retry of the action
can confirm, and the request still points at that output.

For that case, use the admin re-apply instead of SQL:

1. `GET /api/v1/hydra/head/l2-reservations/stalled-release?headId=<head-id>`
   returns the released row replay holds on, with `reapplicable` and
   `blockedReason`. The head's Overview tab shows the same thing in the stall
   notice, with a Re-apply button.
2. `POST /api/v1/hydra/head/l2-reservations/reapply` with `headId`,
   `transactionId` and `expectedUpdatedAt` (the `updatedAt` from step 1).

The re-apply is the exact inverse of the release's action branch, in one
serializable transaction. The row goes back to `Pending` with its release stamp
cleared, and each request goes back to the row as its `CurrentTransaction` and
to its in-flight action (for example `WithdrawRequested` back to
`WithdrawInitiated`). The next replay pass then applies the body the normal way
and clears the stall. The request never sits in its retry action, so the
batcher cannot build a second retry in between.

The server refuses the re-apply unless all of these hold:

- Replay holds on this body with `replay-apply-retry`.
- The row is `RolledBack` with `l2ReleasedByOperatorAt` set, has no `txHash`,
  no recorded on-chain states, and no wallet points at it.
- Our node shows the body confirmed, and the body spends the escrow output each
  request points at.
- Each request is still where the release left it: `CurrentTransaction` is the
  escrow the reservation replaced. The in-flight action the release replaced
  is the oldest one created since the reservation, and it must be the
  in-flight form of the action the row recorded in
  `l2ReservationPreviousActionId`. Every action created after it (history and
  the current one) is either its retry (same result hash) or the
  `WaitingForManualAction` parking that the failed retries against the spent
  escrow output end in. A retry in flight is refused; wait until it settles. A
  request that was ever recovered to any other action since the release is
  refused too, even when that action was later rolled back.
- The server runs these checks again inside the write transaction.
- The row is unchanged since `expectedUpdatedAt`.

Two cases are always refused, and they are still invariant breaches that need
investigation, not a retry:

- An initial lock. Its release sent the purchase back to locking and overwrote
  the purchase fields the body's datum was built from, and the purchase may
  already be locked a second time.
- A release on the nudge proof. That proof says the body can never confirm, so
  a confirmation means the proof failed.

## Do NOT

- Release a reservation while the head is still within the signed validity
  window. The body can still land.
- Release on expiry plus history or UTxO absence alone. A withheld snapshot
  signed before expiry can still apply the body.
- Delete the Transaction row — it is the only durable record of the signed
  body's identity (`intendedTxHash`) and of the pre-reservation state.
- "Fix" this by removing the fail-closed retention in
  `l2-lock.ts` / `l2-reservation-recovery.ts`. The verified release nudge is
  the automated proof.
