-- Align the implicit m-n join tables with the layout the current Prisma client
-- expects: a PRIMARY KEY on ("A","B") in place of the older unique index.
--
-- Guarded, and that is the whole point of this file's current shape. It was
-- written unguarded, and it sorts BEFORE
-- 20260721000000_transaction_history_join_table_primary_keys, which performs
-- the same change and had already shipped. On a database that has run that
-- migration — every existing deployment — this one is still pending, so
-- `prisma migrate deploy` runs it second and Postgres refuses:
--
--   ERROR: multiple primary keys for table "_PaymentTransactionHistory"
--   are not allowed (42P16)
--
-- The deploy then aborts with a failed row in `_prisma_migrations`, so none of
-- the Hydra migrations after it apply and every later deploy refuses until
-- someone runs `prisma migrate resolve` by hand against production. Fresh
-- databases never showed it: there this runs first and 20260721000000's own
-- EXCEPTION block absorbs the duplicate.
--
-- Kept rather than deleted so databases that already applied it keep a
-- migration history that matches the folder.
--
-- The PK is added before the unique index is dropped, so ("A","B") uniqueness
-- is never briefly unenforced.

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
