---
id: '02'
title: Wallet UTxO serialization and chaining
type: research
status: closed
assignee: research-subagent
blocked_by: []
---

# Wallet UTxO serialization and chaining

## Question

How does the service serialize and select a payment-source wallet's UTxOs
today, and can it cope with a wallet whose whole balance sits on **one**
stateful UTxO that every spend must re-create?

Cover: per-wallet locking and whether one in-flight transaction is already
enforced; how spendable UTxOs are chosen and which are reserved or excluded;
whether anything chains onto a still-unconfirmed output from the same wallet;
how long a wallet is blocked waiting for confirmation; what the splitter and
defragmentation logic exist for; and how a collateral UTxO is kept available.

And specifically:

- Which code paths break or degrade if a wallet has exactly one spendable UTxO?
- Does anything need two independent wallet UTxOs in the **same** transaction —
  one as collateral, one as a spending input?
- How many transactions per wallet does the service realistically submit in a
  short window?

## Why it matters

The operator has fixed serialized wallet spends with intra-transaction batching
preserved. That is only viable if the service's existing cadence tolerates one
wallet UTxO per block — and if collateral can come from somewhere other than
the treasury.

## Resolution

### Serialization is already exactly what the wallet needs

The service permits **one in-flight transaction per wallet, full stop**.
`HotWallet.pendingTransactionId` is `@unique` (`prisma/schema.prisma:95`) and
every work query filters `PendingTransaction: { is: null }, lockedAt: null`
(`src/utils/db/lock-and-query-purchases/index.ts:48-58`, and the payments,
registry and inbox equivalents). Claims happen inside per-wallet Serializable
transactions with no `SELECT … FOR UPDATE` — Postgres SSI serializes
contenders and the loser retries on 40001 (`:62-141`). There are no advisory
locks in the wallet path.

Around twenty scheduler jobs contend for that single slot on 15–30 s intervals
(`src/services/monitoring/scheduler/jobs.ts:21-343`), but the effective rate is
bounded by confirmation, not cadence: **one transaction per wallet per ~40–90
seconds**, with `BLOCK_CONFIRMATIONS_THRESHOLD = 1`
(`packages/payment-core/src/config.ts:122-127`). A wedged wallet is blocked
5–7 minutes worst case (`WALLET_LOCK_TIMEOUT_INTERVAL` 300 s,
`DEFAULTS.TX_TIMEOUT_INTERVAL` 7 min).

So a single stateful wallet UTxO whose continuing output feeds the next
transaction matches the concurrency model the service already enforces. The
operator's serialization constraint costs nothing that is not already paid.

### There is no chaining, and none is needed

Nothing anywhere spends an output from an unconfirmed transaction. Every build
re-fetches live via `wallet.getUtxos()`
(`src/utils/generator/wallet-generator/index.ts:33`); the only UTxO cache is
keyed by smart-contract address for a V1 diagnostic and never reaches a builder
(`src/services/shared/escrow-utxo.ts:29`). The `intendedTxHash` computed before
broadcast at twelve call sites is for ambiguous-submit reconciliation, never
turned into an input. The established pattern is **defer a tick**, stated
outright at `packages/payment-source-v2/src/services/payments/collection/service.ts:430-441`,
and collateral prep blocks rather than chains
(`wallet-collateral/ensure-collateral-ready.ts:214-218`).

### The two-UTxO floor is about the key wallet, not the script wallet

`classifyWalletState` gates on `ready = hasGoodCollateral && utxoCount >= 2`
(`ensure-collateral-ready.ts:163`), normatively stated in
`docs/adr/0007-v2-collateral-readiness-invariant.md`. That count is taken over
the **key** wallet's own UTxOs, which under the funding-source model continue to
exist and continue to hold the fee and collateral float. The script wallet's
UTxO lives at a different address and is fetched separately, so it neither
satisfies nor threatens the gate.

The splitter exists to keep that key-side floor alive:
`WALLET_SPLITTER_LOVELACE = 5_000_000n`
(`packages/payment-source-v2/src/builders/batch-helpers.ts:69`), emitted when
the non-collateral wallet UTxO count is exactly 1, unconditionally in the
funds-lock path (`batch-payments/service.ts:333-336`). It is single-use, not
accretive. There is **no runtime defragmentation** anywhere and nothing bounds
the upper UTxO count — the only consolidation tool is a dev script.

### Carried risk for the collateral ticket

`getSpendableWalletUtxos` falls back to the **unfiltered** list when excluding
the collateral would leave nothing (`src/utils/utxo/index.ts:65-68`, duplicated
at `batch-helpers.ts:160-164`), and `buildWithCollateralFallback` deliberately
retries with collateral offered to coin selection
(`batch-interaction.ts:200-216`). A thin key-side float makes both of those
fire more often — the reserve gets spent exactly when it is scarcest.
