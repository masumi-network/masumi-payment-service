-- Hydra: a top-up becomes visible when it is asked for, not when it succeeds.
--
-- An exact-amount top-up carves a dedicated UTxO on L1 and waits for it to
-- confirm before the deposit can be built at all. The row was only created
-- after that, so for the minutes in between the operator saw nothing: no
-- pending entry, no record after a refresh, and funds apparently gone. The row
-- now exists from the moment the request is accepted, which means its deposit
-- hash and validity slot are unknown at insert time.
--
-- Nullable rather than a placeholder hash: reconciliation keys off the hash, and
-- a fake one would be a hash it could go looking for on chain.

ALTER TYPE "HydraTopupStatus" ADD VALUE IF NOT EXISTS 'Preparing' BEFORE 'Pending';

ALTER TABLE "HydraTopup" ALTER COLUMN "depositTxHash" DROP NOT NULL;
ALTER TABLE "HydraTopup" ALTER COLUMN "invalidHereafterSlot" DROP NOT NULL;
