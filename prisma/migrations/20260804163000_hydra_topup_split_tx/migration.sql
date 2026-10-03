-- Hydra: record the pre-split transaction, so the long wait has a hash.
--
-- An exact-amount top-up first pays itself to carve a UTxO of exactly that
-- amount, then waits for it to confirm before the deposit can be built. That
-- wait is the longest part of a top-up and the transaction was never recorded,
-- so during it the funds had left the wallet and nothing in the product named
-- the transaction that took them.

ALTER TABLE "HydraTopup" ADD COLUMN "splitTxHash" TEXT;
