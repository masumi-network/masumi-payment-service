# ADR 0007 — V2 wallet collateral-readiness invariant

## Status

Accepted.

## Context

Every V2 script-spending action — `request-refund`, `collect-refund`,
`submit-result`, `authorize-refund`, `collection`, `authorize-withdrawal`,
and the four registry variants — produces a Cardano transaction whose
body contains both regular `inputs` (the script UTxOs being spent + at
least one fee-paying wallet UTxO) and `collateral_inputs` (a payment-key
wallet UTxO that gets consumed only on phase-2 failure).

Relevant ledger facts:

- A payment-key wallet UTxO may appear in both `tx.body.inputs` and
  `tx.body.collateral_inputs` in the same tx. Cardano does not have a
  general disjointness rule for those sets.
- Collateral must be payment-key-locked. Script-locked UTxOs can never be
  collateral.
- Since Babbage/CIP-40, collateral inputs may carry native tokens when the
  tx body supplies the required `collateral_return_output` and
  `total_collateral`. The V2 builders still prefer pure-ADA collateral where
  available because it keeps collateral-return handling smaller.

After V2 `batch-payments` lands its first tx for a freshly-funded buyer
wallet, the wallet may hold a single change UTxO. Although the ledger could
allow that VKey UTxO to double as collateral and fee input, the current V2
builders maintain a separate confirmed collateral reserve. When the wallet
falls below that service-level shape, the helper defers and restores the
reserve instead of relying on one-UTxO sharing through Mesh coin selection.

V1 does not call this helper and has no splitter/prep convention. Several
V1 single-item builders already pass the same VKey UTxO as both a regular
input and collateral while capping exposure with `setTotalCollateral`.

## Decision

Introduce a wallet-readiness check, `ensureCollateralReady`, that every
V2 script-spending service runs at the start of `processWalletBatch` and
its single-item fallback (`processSingle*`). The helper lives at
`packages/payment-source-v2/src/services/wallet-collateral/ensure-collateral-ready.ts`.

### Invariant

Before any current V2 script-spending tx may be built, the wallet MUST hold:

- **At least one payment-key wallet UTxO of ≥ 5 ADA** (the collateral
  candidate; threshold matches `pickBatchCollateral`'s default and gives
  headroom over the protocol-required collateral which is currently ~3 ADA).
- **At least 2 UTxOs total** (the current service/builder invariant that
  preserves a separate confirmed collateral reserve and a regular wallet
  input/change path).

`classifyWalletState(utxos)` is the pure-function gate that decides
`ready` (both conditions hold) vs. not.

### Helper outcomes

`ensureCollateralReady(...)` returns one of:

- **`{ status: 'ready' }`** — wallet meets the invariant; caller proceeds
  with its real action transaction.
- **`{ status: 'deferred', prepTxHash }`** — wallet did NOT meet the
  invariant but holds enough lovelace to build a self-send "prep" tx.
  The helper:
  1. Builds a pure-value tx that emits a 5-ADA pure-ADA output back to
     the wallet's own address (Mesh fills in change naturally).
  2. Creates a shared `Transaction` row with `status: Pending`,
     `lastCheckedAt: now` (required so `wallet-timeouts` can poll), and
     `BlocksWallet: { connect: { id: walletDbId } }` — locking the
     wallet at the `HotWallet.pendingTransactionId` level.
  3. Submits the tx on chain and records its hash on the row.
  4. Returns `deferred` so the caller leaves its items queued.
- **`{ status: 'failed', reason: 'insufficient_funds' | 'prep_tx_failed' }`** —
  wallet is too underfunded to even build the prep tx, or the prep tx
  failed to submit. The helper explicitly clears the outer caller's
  `lockedAt` (no PendingTransaction was committed, so `wallet-timeouts`
  cannot do it on our behalf — its query filter excludes
  `PendingTransaction == null` rows). Operator-facing log emitted at
  ERROR level.

### Recovery loop

- On `deferred`: the prep tx confirms on chain, `wallet-timeouts`
  observes the txHash via `fetchTxInfo`, disconnects `BlocksWallet`,
  clears `lockedAt`. Next scheduler tick picks the wallet up again, the
  helper sees the new ≥ 2-UTxO state and returns `ready`, action runs.
- On `failed`: caller's `lockedAt` was cleared in the helper. Operator
  must fund / inspect the wallet. Next scheduler tick re-evaluates.

### Phase-2 failure propagation latency

When a submitted tx lands on chain but the script rejects
(`valid_contract = false`), no new script-address UTxO appears so the
normal tx-sync handler never fires. Recovery flows through
`wallet-timeouts/service.ts`, which only re-polls the wallet AFTER its
outer `lockedAt` is older than `WALLET_LOCK_TIMEOUT_INTERVAL` (~30 min).
Until that threshold elapses, every dependent `PaymentRequest` /
`PurchaseRequest` / `RegistryRequest` / `InboxAgentRegistrationRequest`
sits in its `*Initiated` state, and `markTransactionPhase2Failed` cannot
fire.

We accept this latency rather than aggressively re-polling for two
reasons: (a) reading `txDetails.valid_contract` from blockfrost on every
tick burns rate-limit budget for a rare failure mode, and (b) advancing
dependents to a terminal `*Failed`/`WaitingForManualAction` state from a
phase-2 false positive (transient blockfrost lag) would mis-route real
funds. Operators who want faster surfacing should tune
`WALLET_LOCK_TIMEOUT_INTERVAL` downward; the current default trades
latency for safety.

### Batch-submit-failure interaction

When the parent batch service (`request-refund`, `collect-refund`,
`submit-result`, `authorize-refund`, `collection`, `authorize-withdrawal`,
plus the four registry variants) catches a `meshWallet.submitTx` failure
on the BATCH tx, its rollback `$transaction` calls
`disconnectTransactionWallet()` which clears `pendingTransactionId`. It
does NOT clear `lockedAt` — clearing both inside the rollback would race
a concurrent process between rollback commit and the subsequent
`fallbackToSingleItems` single-item submits.

After `fallbackToSingleItems` returns, each batch service calls
`unlockHotWalletIfNoPendingTransaction(wallet.id, ...)`. This atomic
`updateMany` filters on `pendingTransactionId IS NULL` and clears
`lockedAt` ONLY if no single-item submit set a new pending tx — preserving
the lock for tx-sync to release on successful single-item submits, and
freeing it immediately when every single-item attempt deferred.

Without this conditional unlock, an all-deferred batch fallback would
strand the wallet at `(lockedAt=set, pendingTransactionId=null)` for the
full `WALLET_LOCK_TIMEOUT_INTERVAL` (~30 min) until the orphan-lock
branch in `wallet-timeouts` cleared it.

Per ADR-0005, the prep tx is a pure value-transfer with no datum; safe to
build with V1 mesh classes shared via `@/services/shared` (no
script-data-hash or datum CBOR is touched).

### Why blocking (defer one tick) instead of inline (add reserve to every action tx)

We considered emitting an explicit 5-ADA reserve output on every V2
action transaction. Rejected because:

- The collateral input is **not consumed on phase-2 success** — the same
  reserve UTxO survives every successful action tx and naturally persists as
  the wallet's collateral candidate. Once the invariant is bootstrapped, no
  further reserve output is needed.
- Emitting a reserve on every action would grow the wallet by one UTxO
  per action over the lifetime of the wallet — accumulating dust.

The blocking prep-tx pattern bootstraps the invariant **once** at first
use of a wallet (where the helper sees the 1-UTxO state from
`batch-payments`'s change output). Subsequent ticks are no-ops on the
collateral-readiness check.

## Loop-safety audit (gas-fee bounds)

Worst-case gas burn per wallet:

- Cold start: 1 prep tx (~0.18 ADA on preprod).
- Submit OK + post-submit DB hash update fails: bounded to 1 extra prep
  tx (~0.36 ADA total). See the long block comment on the
  post-submit hash-update catch block in `ensure-collateral-ready.ts`
  (search for `[collateral-prep]` "post-submit hash update failed").
- Submit-failure path: 0 ADA gas, helper rolls back the wallet lock and
  returns `failed`.

`HotWallet.pendingTransactionId` (set by `BlocksWallet: { connect }`)
prevents the helper from re-entering for the same wallet — every
`lockAndQueryX` filter requires `PendingTransaction == null`, so a wallet
with a prep tx in flight is invisible to all batch services until the
prep confirms and `wallet-timeouts` clears the lock.

## Consequences

- V2 batch services that use the helper are immune to the
  single-UTxO-wallet failure mode. CI's `[collateral-prep]` annotator
  step (introduced alongside the helper) surfaces every prep-tx event
  in the GitHub workflow run summary.
- Cold start of a fresh wallet costs one round-trip and ~0.18 ADA.
  Subsequent action ticks on the same wallet are no-ops on the readiness
  check.
- V1 services do NOT call the helper. V1's single-item flow naturally
  relies on its own builders and may reuse a VKey UTxO as both regular input
  and collateral; the V2 reserve invariant does not apply there.
- A wallet that runs below the prep-tx funding threshold
  (`PREP_TX_MIN_LOVELACE = 7 ADA`) will surface as
  `status: 'failed', reason: 'insufficient_funds'` and produce a clear
  ERROR log telling the operator to fund the wallet. Better failure
  surface than the previous "silent throw out of `sortAndLimitUtxos`".

## Why `lastCheckedAt` is non-negotiable

`wallet-timeouts/service.ts` filters pending tx rows by
`PendingTransaction: { lastCheckedAt: { lte: now - 1min } }`. Prisma's
`lte` does NOT match `null`. Every `Transaction.create` that
`BlocksWallet: { connect }`s into a hot wallet MUST set `lastCheckedAt`
to a concrete `new Date()` or the wallet would be permanently invisible
to the cleanup cron and stay locked forever on the next process crash
between `tx.transaction.create` and the post-submit `txHash` update.

This applies BOTH to the helper's prep tx AND to every shared-Tx
creation in the V2 batch services (see ADR-0006).

## Amendments (2026-07-04) — V2 registry update/deregister

Holder wallets after SaaS registration often hold ~10 ADA in three UTxOs
(5 ADA collateral, ~3 ADA fee, NFT+ADA). Beyond the base invariant above,
registry update/deregister needed:

1. **`ensureCollateralReady` before `pickBatchCollateral`** on single-item
   update/deregister paths. Wallets that consolidated to one `[NFT+ADA]`
   UTxO never reached prep when collateral was picked first.
2. **`capRegistryMintFundingLovelace`** must reserve ~3 ADA
   (`REGISTRY_PLUTUS_TX_FEE_RESERVE`) for Plutus fees when capping mint
   output funding; a 0.5 ADA reserve caused mesh `UTxO Fully Depleted`.
3. **Registry update worker** must use
   `advancedRetry({ throwOnUnrecoveredError: true })` (or handle
   `success === false`); default `advancedRetry` returned without
   throwing, leaving `UpdateRequested` rows with no persisted `error`.

See `packages/payment-source-v2/src/services/registry/update/service.ts`
and `batch-helpers.ts` (local diff, pending commit).
