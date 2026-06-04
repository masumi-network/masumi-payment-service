# ADR 0006 — Single shared `Transaction` row per V2 multi-redeemer batch

## Status

Accepted.

## Context

V2 introduces the multi-redeemer batch tx pattern: ONE on-chain transaction
spends N script UTxOs (one per `PaymentRequest` or `PurchaseRequest` in the
batch), each with its own redeemer, and emits N continuation outputs. The
V2 batch services (`submit-result`, `authorize-refund`, `collection`,
`request-refund`, `collect-refund`, `authorize-withdrawal`, plus the four
registry variants and the buyer-side `batch-payments`) drive this from a
single scheduler tick.

The pre-V2-batch DB model assumed exactly one `Transaction` row per request:
`PaymentRequest.currentTransactionId` and `PurchaseRequest.currentTransactionId`
were `@unique`, and a request was always paired 1:1 with its in-flight tx via
`CurrentTransaction`. The transition writer (`src/services/shared/transition-writer.ts`)
exposed a `createPendingTransaction(walletId)` helper that wrote a fresh
`Transaction` row and connected the request's `CurrentTransaction` to it.

When V2 batch services tried to reuse that helper inside a `for (const v of fit)`
pre-submit loop, the result was N calls to `tx.transaction.create({...})` —
one per request, each creating a new `Transaction` row with `BlocksWallet: { connect: { id: walletId } }`.

`HotWallet.pendingTransactionId` is `@unique`. Each `BlocksWallet` connect
overwrites the previous one. After N iterations, the wallet pointed at the
LAST tx; the first N-1 were orphaned (no `HotWallet` reverse-relation, no
PaymentRequest pointing at them either — because each request's
`CurrentTransaction` pointed at its OWN newly-created tx). That caused two
real failures observed in CI:

1. **Wallet unlock fragility.** `tx-sync` unlocks the hot wallet by walking
   `paymentRequest.CurrentTransaction.BlocksWallet` for the FIRST processed
   redeemer entry. With N independent Transactions, only the last one (the
   surviving owner of `HotWallet.pendingTransactionId`) had `BlocksWallet`
   set. If that request's tx-sync handler error path took priority — or if
   the redeemer entries arrived in a non-deterministic order — the wallet
   unlock could fail to fire at all.
2. **Bookkeeping pollution.** Every batch tick that landed left N-1 orphan
   `Transaction` rows in the DB. After a handful of ticks, every wallet had
   accumulated a non-trivial trail of `txHash`-less, `BlocksWallet`-less
   rows.

## Decision

The PR enabling V2 batch action services makes two changes:

1. **Drop the `@unique` constraint** on `PaymentRequest.currentTransactionId`
   and `PurchaseRequest.currentTransactionId`. Migration:
   `prisma/migrations/20260522000000_drop_unique_current_transaction_id/migration.sql`.
2. **Create ONE `Transaction` row per batch tick.** The pre-submit code path
   in every V2 batch service now runs:

   ```ts
   const sharedTxId = await retryOnSerializationConflict(
       () => prisma.$transaction(async (tx) => {
           const sharedTx = await tx.transaction.create({
               data: {
                   status: TransactionStatus.Pending,
                   lastCheckedAt: new Date(),
                   BlocksWallet: { connect: { id: walletId } },
               },
           });
           for (const v of fit) {
               await tx.purchaseRequest.update({
                   where: { id: v.request.id },
                   data: {
                       ...connectExistingTransaction(sharedTx.id),
                       // ... per-item action transition fields
                   },
               });
           }
           return sharedTx.id;
       }),
       { label: '<service>-batch-tx' },
   );
   ```

   The new helper `connectExistingTransaction(transactionId)` in
   `src/services/shared/transition-writer.ts` produces the `CurrentTransaction: { connect: { id } }`
   shape — N requests all point at the same `Transaction` row.

3. **Post-submit `txHash` recording** writes the hash exactly once on the
   shared row (`tx.transaction.update({ where: { id: sharedTxId }, data: { txHash } })`),
   not in a per-item loop.

4. **The `Transaction.PaymentRequestCurrent` / `PurchaseRequestCurrent`
   reverse-relation types** changed from `PaymentRequest?` / `PurchaseRequest?`
   to `PaymentRequest[]` / `PurchaseRequest[]` to reflect the new 1-to-many
   shape.

## Consequences

- **`tx-sync` wallet unlock is now deterministic.** The shared `Transaction`
  is the only row carrying `BlocksWallet`. Whichever tx-sync entry processes
  first sees it, disconnects it, and clears `HotWallet.lockedAt`. Subsequent
  entries find `BlocksWallet` null and skip the unlock path — idempotent.
- **DB orphans are gone for the happy path.** Exactly one Transaction row
  per batch tick.
- **Rollback semantics need explicit handling.** On `meshWallet.submitTx`
  failure, each fit item reverts its `CurrentTransaction` back to the
  pre-batch `currentTransactionId` (the per-item rollback loop stays
  per-item). The shared `Transaction` row stays in the DB with
  `status = Pending`, `BlocksWallet = null`, and no `txHash` — it has no
  reverse-relation that `wallet-timeouts` queries through, so it is NOT
  garbage-collected automatically. This is acceptable bloat (one row per
  failed submit, rare in practice) but a future GC sweep should drop
  `Transaction` rows where `BlocksWallet IS NULL`, every
  `PaymentRequestCurrent`/`PurchaseRequestCurrent` array is empty, and
  `txHash IS NULL` and `createdAt < now - 7d`. Wallet-lock release for the
  failure path is handled by `unlockHotWalletIfNoPendingTransaction` called
  after `fallbackToSingleItems` returns (see ADR-0007).
- **`updateRolledBackTransaction`** in `tx-sync/tx/index.ts` had to iterate
  the now-array `PaymentRequestCurrent` / `PurchaseRequestCurrent` instead
  of dereferencing a single optional.
- **V1 single-item flows are unchanged.** V1's pre-submit pattern still
  calls `createPendingTransaction(walletId)` inside a 1-element loop and
  remains 1:1 by construction — the `@unique` was redundant there anyway.

## Why not keep `@unique` and store the shared txHash elsewhere

Alternatives considered:

- **Add a `Transaction.batchTxHash String?` column and keep N rows per
  batch.** Doubles the per-request DB write count and forces the rollback
  path to update every row instead of one.
- **Make `CurrentTransaction` a many-to-many.** Overkill — the
  `Transaction → many requests` shape is already what dropping `@unique`
  expresses.
- **Stay with the N-orphans status quo and patch wallet unlock to walk all
  orphans.** Increases coupling between tx-sync and the batch service code
  paths, and doesn't fix the DB pollution.

Single shared row with relaxed unique constraint is the simplest model that
expresses the 1-tx → N-request relationship the V2 batch actually has on
chain.
