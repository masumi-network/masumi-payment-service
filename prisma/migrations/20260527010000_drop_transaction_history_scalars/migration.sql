-- Drop the legacy `Transaction.paymentRequestHistoryId` /
-- `Transaction.purchaseRequestHistoryId` scalar columns and any lingering
-- indexes / FKs on them. Backfill into the `_PaymentTransactionHistory`
-- and `_PurchaseTransactionHistory` join tables was completed by the
-- companion additive migration:
--   prisma/migrations/20260525001000_make_transaction_history_many_to_many
--
-- ROLLOUT REQUIREMENT:
-- This migration MUST run AFTER every application replica is on the new
-- code (which writes history via the join tables only). The previous
-- additive migration intentionally kept the scalars in place to support
-- a rolling deploy where old and new replicas coexisted briefly. Running
-- this drop migration crashes any still-running old replica that
-- references the scalar columns via its Prisma client. Standard
-- deploy-then-migrate ordering avoids the race.
--
-- IF NOT EXISTS guards: safe to re-run / replay. The companion additive
-- migration's `RAISE NOTICE 'column already dropped, skipping backfill'`
-- branches detect this drop has happened and short-circuit.

-- Drop any lingering FK constraints first (the additive migration already
-- dropped these via `DROP CONSTRAINT IF EXISTS`, but re-guard here in case
-- a partial replay re-created them).
ALTER TABLE "Transaction" DROP CONSTRAINT IF EXISTS "Transaction_paymentRequestHistoryId_fkey";
ALTER TABLE "Transaction" DROP CONSTRAINT IF EXISTS "Transaction_purchaseRequestHistoryId_fkey";

-- Drop any indexes on the scalars (Prisma generated `@@index` names).
DROP INDEX IF EXISTS "Transaction_paymentRequestHistoryId_idx";
DROP INDEX IF EXISTS "Transaction_purchaseRequestHistoryId_idx";

-- Drop the columns themselves.
ALTER TABLE "Transaction" DROP COLUMN IF EXISTS "paymentRequestHistoryId";
ALTER TABLE "Transaction" DROP COLUMN IF EXISTS "purchaseRequestHistoryId";
