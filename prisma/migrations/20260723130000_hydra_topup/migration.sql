-- CreateEnum
CREATE TYPE "HydraTopupStatus" AS ENUM ('Pending', 'Confirmed', 'Failed');

-- CreateTable
CREATE TABLE "HydraTopup" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "hydraHeadId" TEXT NOT NULL,
    "hydraLocalParticipantId" TEXT NOT NULL,
    "depositTxHash" TEXT NOT NULL,
    "invalidHereafterSlot" BIGINT NOT NULL,
    "committedLovelace" BIGINT NOT NULL,
    "committedAssets" JSONB NOT NULL,
    "status" "HydraTopupStatus" NOT NULL DEFAULT 'Pending',

    CONSTRAINT "HydraTopup_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "HydraTopup_hydraLocalParticipantId_status_idx" ON "HydraTopup"("hydraLocalParticipantId", "status");

-- CreateIndex
CREATE INDEX "HydraTopup_status_updatedAt_idx" ON "HydraTopup"("status", "updatedAt");

-- CreateIndex
CREATE INDEX "HydraTopup_hydraHeadId_idx" ON "HydraTopup"("hydraHeadId");

-- At most one in-flight (Pending) top-up per local participant. Enforced as a
-- partial unique index (not expressible in schema.prisma) so the reservation is
-- race-proof at the database layer, mirroring HydraHead's non-Final partial
-- unique index. A new top-up therefore fails closed with a unique-violation
-- while a prior deposit is still awaiting L1 reconciliation.
CREATE UNIQUE INDEX "HydraTopup_one_pending_per_participant_key" ON "HydraTopup"("hydraLocalParticipantId") WHERE "status" = 'Pending';

-- AddForeignKey
ALTER TABLE "HydraTopup" ADD CONSTRAINT "HydraTopup_hydraHeadId_fkey" FOREIGN KEY ("hydraHeadId") REFERENCES "HydraHead"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HydraTopup" ADD CONSTRAINT "HydraTopup_hydraLocalParticipantId_fkey" FOREIGN KEY ("hydraLocalParticipantId") REFERENCES "HydraLocalParticipant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
