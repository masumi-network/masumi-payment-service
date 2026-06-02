# Deploy runbook — Web3CardanoV2 rollout

This branch introduces the `Web3CardanoV2` payment source type alongside the existing `Web3CardanoV1`. Two database migrations need to be applied in order, with the application code deployed in between. The intermediate state is intentionally backwards-compatible so a code rollback after the first migration still works.

## Migrations

| File | What it does | Reversible? |
| --- | --- | --- |
| `prisma/migrations/20260519120000_add_payment_source_type_v2_registry_metadata/migration.sql` | Adds `PaymentSourceType` + `Chain` enums; adds `paymentSourceType`, `requiredAdminSignatures` columns to `PaymentSource`; relaxes `adminWalletId` to nullable; adds `buyerReturnAddress` / `sellerReturnAddress` columns to `PaymentRequest` and `PurchaseRequest`; adds `OnChainState.WithdrawAuthorized`, `OnChainState.RefundAuthorized`, `PurchasingAction.AuthorizeWithdrawalRequested`, `PurchasingAction.AuthorizeWithdrawalInitiated`; creates `SupportedPaymentSource` child table; drops the strict unique on `(network, policyId)` in favour of a non-unique index; backfills `SupportedPaymentSource` rows from every existing V1 `RegistryRequest`. | Partially. Enum `ADD VALUE` operations are not reversible in Postgres; the column adds, table creation, and index changes are reversible by inverse SQL. |
| `prisma/migrations/20260520000000_drop_legacy_payment_type_enum/migration.sql` | Drops the `paymentType` column from `RegistryRequest` and the `PaymentType` enum. | Recreatable by `ALTER TABLE ... ADD COLUMN "paymentType" "PaymentType" NOT NULL DEFAULT 'Web3CardanoV1'`, but the data is lost. |

## Deploy sequence

1. **Pre-deploy snapshot.** `pg_dump --schema-only -d $DB > pre-v2-schema.sql` and `pg_dump --data-only -t '"RegistryRequest"' -t '"PaymentSource"' -d $DB > pre-v2-data.sql`. Keep these aside for the duration of the rollout window.
2. **Apply Migration A.** `pnpm prisma migrate deploy` will pick it up. If Migration B is already on the same branch tip, run only Migration A explicitly by applying `prisma/migrations/20260519120000_*/migration.sql` via `psql` and inserting a row into `_prisma_migrations` manually — or stage Migration B on a follow-up commit so `migrate deploy` runs A alone.
3. **Run the backfill verification query** (also embedded as a comment in Migration A):
   ```sql
   SELECT
     (SELECT COUNT(*) FROM "RegistryRequest" WHERE "paymentType" = 'Web3CardanoV1') AS expected,
     (SELECT COUNT(*) FROM "SupportedPaymentSource") AS actual;
   ```
   `expected` and `actual` must match. If they don't, investigate before continuing — the most likely cause is an orphan `RegistryRequest` whose `paymentSourceId` references a soft-deleted `PaymentSource`. Either fix the orphan or `INSERT … ON CONFLICT DO NOTHING` again with looser join semantics.
4. **Deploy application code** (this branch). The new code reads `SupportedPaymentSource` rows exclusively and never writes `paymentType`. Prisma client (regenerated against `schema.prisma`) omits the legacy column from inserts; Postgres uses the column's default (`Web3CardanoV1`) for any rows written in this window. That is harmless because nothing reads it.
5. **Soak.** Let the new code run for at least one full set of scheduled job cycles (default ~10 minutes). Watch for `Error in V2 …` log lines, `404` spikes on `/api/v1/inbox/*`, or `P2002` Prisma errors.
6. **Smoke-test V1 and V2 flows.** Register a new V1 agent, observe the `SupportedPaymentSource` row gets written via the nested create. Register a new V2 agent. Open a V2 purchase via the new `smartContractAddress` field. Verify the inbox routes work for both V1 and V2 sources.
7. **Apply Migration B** after a confidence window of at least 24 hours. `pnpm prisma migrate deploy` will apply it. The column drop is fast and non-locking on a column with a default; no need for a downtime window.

## Rollback

| State | Code rollback path | DB rollback path |
| --- | --- | --- |
| Pre-Migration-A | Revert branch | None needed |
| Migration A applied, code deployed, Migration B not yet | Revert branch (old code uses `paymentType` column, still present with default) | Drop new tables/columns/indexes (manually written down SQL) |
| Migration A + B both applied | Revert branch | Recreate `PaymentType` enum and `paymentType` column with default `'Web3CardanoV1'`; data is lost for `paymentType = 'None'` rows (was already empty in `SupportedPaymentSource`, so functionally equivalent) |

Reverting after Migration B requires accepting:
- The four V2 `OnChainState` / `PurchasingAction` enum values cannot be removed via SQL. They will remain in the enum forever. Old code ignores them on read.
- Any `RegistryRequest` rows written with `SupportedPaymentSource` data but no legacy `paymentType` write will show `paymentType = 'Web3CardanoV1'` (the default) post-rollback. This is harmless for V1 agents and misleading for V2 agents — but V2 agents would not have been registered if you're rolling back V2 anyway.

## Seed behaviour

`prisma/seed.ts` creates one `PaymentSource` per network per Type (V1 + V2 = 2 sources per network). Set `SEED_ONLY_IF_EMPTY=true` for production-safe re-runs — the guard now checks both `apiKey.count()` and `paymentSource.count()` and bails if either is non-empty.

V2 wallet mnemonics are required via environment variables and the seed will throw if any are missing:
- `PURCHASE_WALLET_V2_PREPROD_MNEMONIC`
- `SELLING_WALLET_V2_PREPROD_MNEMONIC`
- `PURCHASE_WALLET_V2_MAINNET_MNEMONIC`
- `SELLING_WALLET_V2_MAINNET_MNEMONIC`

The seed refuses to brew random V2 mnemonics because contract addresses are derived from wallet identities — a brewed mnemonic would produce a V2 PaymentSource whose deployed contract you don't actually control. V1 retains the brew fallback for backwards compatibility.

## Mesh-SDK version policy

V1 contracts on chain were derived with `@meshsdk/core@1.9.0-beta.96` + `@meshsdk/core-cst@1.9.0-beta.90`. The V1 package and root workspace pin these versions; do not bump them. V2 tracks the latest mesh release. See [ADR-0004](../adr/0004-per-payment-source-type-service-trees.md) for the rationale and the type-bridge pattern used to interop V1-mesh wallets with V2-package services.

## Operational reference — V1 vs V2 entry points

Both Types run side-by-side in the scheduler. Each Type's jobs filter to its own `PaymentSourceType`:

| Concern | V1 entry | V2 entry |
| --- | --- | --- |
| Collect outstanding payments | `web3CardanoV1.collectOutstandingPayments` | `web3CardanoV2.collectOutstandingPayments` |
| Submit result | `web3CardanoV1.submitResult` | `web3CardanoV2.submitResult` |
| Authorize refund | `web3CardanoV1.authorizeRefund` | `web3CardanoV2.authorizeRefund` |
| Cancel refund (V1) / Authorize withdrawal (V2) | `web3CardanoV1.cancelRefunds` | `web3CardanoV2.authorizeWithdrawals` |
| Collect refund | `web3CardanoV1.collectRefund` | `web3CardanoV2.collectRefund` |
| Request refund | `web3CardanoV1.requestRefunds` | `web3CardanoV2.requestRefunds` |
| Batch payments | `web3CardanoV1.batchLatestPaymentEntries` | `web3CardanoV2.batchLatestPaymentEntries` |
| Register agent | `web3CardanoV1.registerAgent` | `web3CardanoV2.registerAgent` |
| Deregister agent | `web3CardanoV1.deRegisterAgent` | `web3CardanoV2.deRegisterAgent` |
| Registry tx sync | `web3CardanoV1.checkRegistryTransactions` | `web3CardanoV2.checkRegistryTransactions` |
| Inbox register | `web3CardanoV1.registerInboxAgent` | `web3CardanoV2.registerInboxAgent` |
| Inbox deregister | `web3CardanoV1.deRegisterInboxAgent` | `web3CardanoV2.deRegisterInboxAgent` |
| Inbox tx sync | `web3CardanoV1.checkInboxAgentRegistrationTransactions` | `web3CardanoV2.checkInboxAgentRegistrationTransactions` |
| Auto decisions | `web3CardanoV1.handleAutomaticDecisions` | `web3CardanoV2.handleAutomaticDecisions` |
