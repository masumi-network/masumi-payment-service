ALTER TABLE "HydraDecommit" ADD COLUMN "l1ObservedAt" TIMESTAMP(3);
ALTER TABLE "HydraDecommit" ADD COLUMN "l1CheckedAt" TIMESTAMP(3);

UPDATE "HydraDecommit"
SET "l1ObservedAt" = COALESCE("finalizedAt", "updatedAt"),
    "status" = 'Approved',
    "finalizedAt" = NULL
WHERE "status" = 'Finalized';

CREATE INDEX "HydraDecommit_status_l1ObservedAt_idx" ON "HydraDecommit"("status", "l1ObservedAt");
CREATE INDEX "HydraDecommit_status_l1CheckedAt_idx" ON "HydraDecommit"("status", "l1CheckedAt");
