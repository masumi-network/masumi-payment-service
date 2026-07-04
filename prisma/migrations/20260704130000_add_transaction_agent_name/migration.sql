-- Denormalized agent display name for transaction search (MAS-432).

ALTER TABLE "PaymentRequest" ADD COLUMN "agentName" TEXT;
ALTER TABLE "PaymentRequest" ADD COLUMN "agentNameSyncedAt" TIMESTAMP(3);

ALTER TABLE "PurchaseRequest" ADD COLUMN "agentName" TEXT;
ALTER TABLE "PurchaseRequest" ADD COLUMN "agentNameSyncedAt" TIMESTAMP(3);

CREATE INDEX "PaymentRequest_agentNameSynced_pending_idx" ON "PaymentRequest" ("id") WHERE "agentNameSyncedAt" IS NULL;

CREATE INDEX "PurchaseRequest_agentNameSynced_pending_idx" ON "PurchaseRequest" ("id") WHERE "agentNameSyncedAt" IS NULL;
