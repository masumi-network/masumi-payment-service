-- Persist the signed batch transaction's ledger expiry so a missing hash is
-- never requeued solely because a wall-clock timeout elapsed.
ALTER TABLE "Transaction"
ADD COLUMN IF NOT EXISTS "invalidHereafterSlot" BIGINT;

-- One Cardano batch has one signed body and therefore one Transaction row.
-- Allow every participating PurchaseRequest to reference that shared row.
DROP INDEX IF EXISTS "PurchaseRequest_currentTransactionId_key";

CREATE INDEX IF NOT EXISTS "PurchaseRequest_currentTransactionId_idx"
ON "PurchaseRequest" ("currentTransactionId");

-- A shared batch transaction must remain in every participating request's
-- history after reconciliation. Keep the legacy scalar relation for rolling
-- deploy compatibility, while new code writes the many-to-many relation.
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

CREATE UNIQUE INDEX IF NOT EXISTS "_PurchaseTransactionHistory_AB_unique"
ON "_PurchaseTransactionHistory" ("A", "B");

CREATE INDEX IF NOT EXISTS "_PurchaseTransactionHistory_B_index"
ON "_PurchaseTransactionHistory" ("B");

DO $$ BEGIN
    INSERT INTO "_PurchaseTransactionHistory" ("A", "B")
    SELECT "purchaseRequestHistoryId", "id"
    FROM "Transaction"
    WHERE "purchaseRequestHistoryId" IS NOT NULL
    ON CONFLICT DO NOTHING;
EXCEPTION
    -- The refactored branch already moved history fully to this join table and
    -- dropped the legacy scalar. Keep this migration merge-safe across branches.
    WHEN undefined_column THEN NULL;
END $$;
