-- The L1 transaction that paid a withdrawal out.
--
-- Distinct from "decommitTxId", which names a transaction that only ever
-- existed inside the head and therefore cannot be looked up on a chain
-- explorer. Nullable because the head never reports this id: it is observed on
-- chain after finalization, and a withdrawal whose payout has not been
-- identified is still a settled withdrawal.
ALTER TABLE "HydraDecommit" ADD COLUMN "l1TxId" TEXT;
