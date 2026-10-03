-- Operator surface for fail-closed Hydra replay halts: persist which confirmed
-- transaction the ordered replay is stuck on (and why) instead of only logging.
ALTER TABLE "HydraHead" ADD COLUMN "reconciliationStalledTxId" TEXT;
ALTER TABLE "HydraHead" ADD COLUMN "reconciliationStalledReason" TEXT;
ALTER TABLE "HydraHead" ADD COLUMN "reconciliationStalledSince" TIMESTAMP(3);
