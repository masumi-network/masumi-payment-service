-- Align the implicit m-n join tables with what the current Prisma client
-- expects. `_PaymentTransactionHistory` / `_PurchaseTransactionHistory` were
-- hand-written in 20260525001000 with the older Prisma layout (a unique index
-- on ("A","B")). Current Prisma models implicit relation tables with a
-- PRIMARY KEY on ("A","B") instead, so `migrate diff` reported persistent
-- drift between the migration history and schema.prisma.
--
-- The PK is added BEFORE the unique index is dropped so the (A,B) uniqueness
-- guarantee is never briefly unenforced. The PK's own implicit index makes the
-- old `_AB_unique` index redundant.
--
-- Guarded with DO blocks / IF EXISTS for partial-replay safety, matching the
-- idiom used by 20260525001000.

-- _PaymentTransactionHistory
DO $$ BEGIN
    ALTER TABLE "_PaymentTransactionHistory"
        ADD CONSTRAINT "_PaymentTransactionHistory_AB_pkey" PRIMARY KEY ("A", "B");
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL; END $$;

DROP INDEX IF EXISTS "_PaymentTransactionHistory_AB_unique";

-- _PurchaseTransactionHistory
DO $$ BEGIN
    ALTER TABLE "_PurchaseTransactionHistory"
        ADD CONSTRAINT "_PurchaseTransactionHistory_AB_pkey" PRIMARY KEY ("A", "B");
EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL; END $$;

DROP INDEX IF EXISTS "_PurchaseTransactionHistory_AB_unique";
