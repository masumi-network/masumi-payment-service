-- V2 batch flows can reuse one Transaction row for multiple requests. Current
-- transaction relations already allow that, but history used scalar nullable
-- foreign keys on Transaction, so connecting a shared tx to a second request
-- moved it out of the first request's history. Move history to implicit Prisma
-- many-to-many join tables and backfill existing scalar links.

CREATE TABLE "_PaymentTransactionHistory" (
    "A" TEXT NOT NULL,
    "B" TEXT NOT NULL,

    CONSTRAINT "_PaymentTransactionHistory_A_fkey" FOREIGN KEY ("A") REFERENCES "PaymentRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "_PaymentTransactionHistory_B_fkey" FOREIGN KEY ("B") REFERENCES "Transaction"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "_PaymentTransactionHistory_AB_unique" ON "_PaymentTransactionHistory"("A", "B");
CREATE INDEX "_PaymentTransactionHistory_B_index" ON "_PaymentTransactionHistory"("B");

-- Guard the backfill against partial replay: if this migration was previously
-- applied past the DROP COLUMN further down, "paymentRequestHistoryId" no
-- longer exists and a re-run would raise undefined_column. We swallow that
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

CREATE TABLE "_PurchaseTransactionHistory" (
    "A" TEXT NOT NULL,
    "B" TEXT NOT NULL,

    CONSTRAINT "_PurchaseTransactionHistory_A_fkey" FOREIGN KEY ("A") REFERENCES "PurchaseRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "_PurchaseTransactionHistory_B_fkey" FOREIGN KEY ("B") REFERENCES "Transaction"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "_PurchaseTransactionHistory_AB_unique" ON "_PurchaseTransactionHistory"("A", "B");
CREATE INDEX "_PurchaseTransactionHistory_B_index" ON "_PurchaseTransactionHistory"("B");

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

ALTER TABLE "Transaction" DROP CONSTRAINT IF EXISTS "Transaction_paymentRequestHistoryId_fkey";
ALTER TABLE "Transaction" DROP CONSTRAINT IF EXISTS "Transaction_purchaseRequestHistoryId_fkey";

ALTER TABLE "Transaction" DROP COLUMN IF EXISTS "paymentRequestHistoryId";
ALTER TABLE "Transaction" DROP COLUMN IF EXISTS "purchaseRequestHistoryId";
