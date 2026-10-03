-- A head that refuses a transaction body by hash is the only unambiguous
-- evidence an L2 reservation can get: absence from history replay never proves
-- absence from the ledger, so without this a reservation is held forever.
ALTER TABLE "Transaction" ADD COLUMN "l2RejectedByHeadAt" TIMESTAMP(3);
ALTER TABLE "Transaction" ADD COLUMN "l2RejectedByHeadReason" TEXT;
