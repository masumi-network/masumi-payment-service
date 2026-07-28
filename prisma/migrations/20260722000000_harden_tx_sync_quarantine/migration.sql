-- Source-wide epochs order scanner evidence against reconciler/scanner
-- business writes across service instances.
ALTER TABLE "PaymentSource"
ADD COLUMN "txSyncFenceVersion" INTEGER NOT NULL DEFAULT 0;

-- Cross-process processing claims prevent duplicate application and fence
-- Retry/Delete mutations from an active reconciler.
ALTER TABLE "TxSyncQuarantine"
ADD COLUMN "processingLeaseId" TEXT,
ADD COLUMN "processingLeaseExpiresAt" TIMESTAMP(3),
ADD COLUMN "canonicalRollbackAt" TIMESTAMP(3);

-- Scanner descendants are queued explicitly rather than applied ahead of an
-- unresolved predecessor.
ALTER TYPE "TxSyncQuarantineReason" ADD VALUE 'PredecessorPending';
ALTER TYPE "TxSyncQuarantineReason" ADD VALUE 'CanonicalRollback';

-- Multi-instance reconcilers use this to find expired/available claims.
CREATE INDEX "TxSyncQuarantine_processingLeaseExpiresAt_idx"
ON "TxSyncQuarantine"("processingLeaseExpiresAt");

CREATE INDEX "TxSyncQuarantine_canonicalRollbackAt_idx"
ON "TxSyncQuarantine"("canonicalRollbackAt");
