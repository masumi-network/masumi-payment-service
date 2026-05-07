-- PaymentRequest / PurchaseRequest: denormalized agent id + sync marker for idempotent startup backfill.

ALTER TABLE "PaymentRequest" ADD COLUMN "agentIdentifier" TEXT;
ALTER TABLE "PaymentRequest" ADD COLUMN "agentIdentifierSyncedAt" TIMESTAMP(3);

ALTER TABLE "PurchaseRequest" ADD COLUMN "agentIdentifier" TEXT;
ALTER TABLE "PurchaseRequest" ADD COLUMN "agentIdentifierSyncedAt" TIMESTAMP(3);

-- Partial indexes: empty once all rows have completed sync (avoids full-table scans on every boot).
CREATE INDEX "PaymentRequest_agentIdentifierSynced_pending_idx" ON "PaymentRequest" ("id") WHERE "agentIdentifierSyncedAt" IS NULL;

CREATE INDEX "PurchaseRequest_agentIdentifierSynced_pending_idx" ON "PurchaseRequest" ("id") WHERE "agentIdentifierSyncedAt" IS NULL;
