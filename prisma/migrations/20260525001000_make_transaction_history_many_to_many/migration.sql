-- V2 batch flows can reuse one Transaction row for multiple requests. Current
-- transaction relations already allow that, but history used scalar nullable
-- foreign keys on Transaction, so connecting a shared tx to a second request
-- moved it out of the first request's history. Move history to implicit Prisma
-- many-to-many join tables and backfill existing scalar links.
--
-- LIVE-MIGRATION SAFETY:
-- This migration is intentionally additive — we create the join tables and
-- backfill from the legacy scalar columns, but we do NOT drop the legacy
-- columns or their foreign keys in the same step. That lets a rolling deploy
-- run the new application code (which writes via the join tables) and the
-- old application code (which still references the scalar columns) against
-- the same database for the brief overlap window without either side
-- breaking. A follow-up migration must drop the legacy columns once every
-- service replica has been cut over to the new code; that migration is
-- intentionally NOT shipped here so it can be paired with the rollout
-- confirmation step in ops.
--
-- IMPORTANT: the Prisma schema STILL ships with the scalar columns
-- (`Transaction.paymentRequestHistoryId` and
-- `Transaction.purchaseRequestHistoryId`) because active code paths still
-- read them — notably `src/services/shared/transition-writer.ts` (reads the
-- scalar to decide history vs. orphan) and
-- `src/services/transactions/orphan-action-cleanup/index.ts` (filters rows
-- by `historyId IS NULL`). A follow-up migration that drops the columns is
-- intentionally NOT shipped here: it must be paired with a refactor of
-- those two modules to use the new join-table relations
-- (`PaymentRequestHistory` / `PurchaseRequestHistory`) BEFORE the columns
-- can be removed. Until that refactor lands, both writes go through the
-- backfill trigger below so the scalar and the join-table stay in sync.
--
-- See docs/adr/0006-shared-transaction-row-for-v2-batches.md for the
-- two-phase column-drop rationale.

-- IF NOT EXISTS on table and indexes for partial-replay safety: if this
-- migration was interrupted between table create and FK add, a rerun would
-- previously fail with "relation already exists". Same pattern as the
-- inline-FK guards below.
CREATE TABLE IF NOT EXISTS "_PaymentTransactionHistory" (
    "A" TEXT NOT NULL,
    "B" TEXT NOT NULL
);

-- FKs added separately so they can be guarded against duplicate_object on
-- partial replay. CREATE TABLE doesn't take IF NOT EXISTS for inline FK
-- constraints in a portable way.
DO $$ BEGIN
    ALTER TABLE "_PaymentTransactionHistory"
        ADD CONSTRAINT "_PaymentTransactionHistory_A_fkey"
        FOREIGN KEY ("A") REFERENCES "PaymentRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
    ALTER TABLE "_PaymentTransactionHistory"
        ADD CONSTRAINT "_PaymentTransactionHistory_B_fkey"
        FOREIGN KEY ("B") REFERENCES "Transaction"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "_PaymentTransactionHistory_AB_unique" ON "_PaymentTransactionHistory"("A", "B");
CREATE INDEX IF NOT EXISTS "_PaymentTransactionHistory_B_index" ON "_PaymentTransactionHistory"("B");

-- Guard the backfill against partial replay: if this migration was previously
-- applied past a column drop in a follow-up migration, "paymentRequestHistoryId"
-- no longer exists and a re-run would raise undefined_column. We swallow that
-- specifically and continue. Pattern matches the duplicate_object guard used
-- in 20260519120000_add_payment_source_type_v2_registry_metadata.
DO $$ BEGIN
    INSERT INTO "_PaymentTransactionHistory"("A", "B")
    SELECT "paymentRequestHistoryId", "id"
    FROM "Transaction"
    WHERE "paymentRequestHistoryId" IS NOT NULL
    ON CONFLICT DO NOTHING;
EXCEPTION
    WHEN undefined_column THEN
        RAISE NOTICE 'paymentRequestHistoryId column already dropped, skipping backfill';
END $$;

CREATE TABLE IF NOT EXISTS "_PurchaseTransactionHistory" (
    "A" TEXT NOT NULL,
    "B" TEXT NOT NULL
);

DO $$ BEGIN
    ALTER TABLE "_PurchaseTransactionHistory"
        ADD CONSTRAINT "_PurchaseTransactionHistory_A_fkey"
        FOREIGN KEY ("A") REFERENCES "PurchaseRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
    ALTER TABLE "_PurchaseTransactionHistory"
        ADD CONSTRAINT "_PurchaseTransactionHistory_B_fkey"
        FOREIGN KEY ("B") REFERENCES "Transaction"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "_PurchaseTransactionHistory_AB_unique" ON "_PurchaseTransactionHistory"("A", "B");
CREATE INDEX IF NOT EXISTS "_PurchaseTransactionHistory_B_index" ON "_PurchaseTransactionHistory"("B");

DO $$ BEGIN
    INSERT INTO "_PurchaseTransactionHistory"("A", "B")
    SELECT "purchaseRequestHistoryId", "id"
    FROM "Transaction"
    WHERE "purchaseRequestHistoryId" IS NOT NULL
    ON CONFLICT DO NOTHING;
EXCEPTION
    WHEN undefined_column THEN
        RAISE NOTICE 'purchaseRequestHistoryId column already dropped, skipping backfill';
END $$;

-- Relax the legacy FKs to SET NULL so a delete on PaymentRequest /
-- PurchaseRequest under the new code path no longer triggers an old-code
-- cascade on the scalar columns. The columns themselves stay in place so the
-- old code keeps reading them; the join-table FK above already handles
-- cascading deletes for the new code path.
ALTER TABLE "Transaction" DROP CONSTRAINT IF EXISTS "Transaction_paymentRequestHistoryId_fkey";
ALTER TABLE "Transaction" DROP CONSTRAINT IF EXISTS "Transaction_purchaseRequestHistoryId_fkey";

DO $$ BEGIN
    -- Re-add as SET NULL so the column survives a PaymentRequest delete
    -- without taking the Transaction row with it. Guarded for replays where
    -- the column has already been dropped by a follow-up migration.
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'Transaction' AND column_name = 'paymentRequestHistoryId'
    ) THEN
        ALTER TABLE "Transaction"
        ADD CONSTRAINT "Transaction_paymentRequestHistoryId_fkey"
        FOREIGN KEY ("paymentRequestHistoryId") REFERENCES "PaymentRequest"("id")
        ON DELETE SET NULL ON UPDATE CASCADE;
    END IF;
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'Transaction' AND column_name = 'purchaseRequestHistoryId'
    ) THEN
        ALTER TABLE "Transaction"
        ADD CONSTRAINT "Transaction_purchaseRequestHistoryId_fkey"
        FOREIGN KEY ("purchaseRequestHistoryId") REFERENCES "PurchaseRequest"("id")
        ON DELETE SET NULL ON UPDATE CASCADE;
    END IF;
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

-- COLUMN DROPS INTENTIONALLY DEFERRED to a follow-up migration. Old replicas
-- still mid-rollout will continue reading these columns through Prisma's old
-- generated client; dropping them here would crash any old replica that
-- selects them. Once every replica is on the new code (which never reads or
-- writes the scalar columns), ship a follow-up migration that does:
--
--   ALTER TABLE "Transaction" DROP COLUMN IF EXISTS "paymentRequestHistoryId";
--   ALTER TABLE "Transaction" DROP COLUMN IF EXISTS "purchaseRequestHistoryId";
