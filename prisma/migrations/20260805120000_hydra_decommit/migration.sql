-- CreateEnum
CREATE TYPE "HydraDecommitStatus" AS ENUM ('Preparing', 'Pending', 'Approved', 'Finalized', 'Failed');

-- CreateTable
CREATE TABLE "HydraDecommit" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "hydraHeadId" TEXT NOT NULL,
    "hydraLocalParticipantId" TEXT NOT NULL,
    "splitTxId" TEXT,
    "decommitTxId" TEXT,
    "requestedLovelace" BIGINT NOT NULL,
    "requestedAssets" JSONB NOT NULL,
    "destinationAddress" TEXT NOT NULL,
    "status" "HydraDecommitStatus" NOT NULL DEFAULT 'Preparing',
    "failureReason" TEXT,
    "approvedAt" TIMESTAMP(3),
    "finalizedAt" TIMESTAMP(3),

    CONSTRAINT "HydraDecommit_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "HydraDecommit_hydraLocalParticipantId_status_idx" ON "HydraDecommit"("hydraLocalParticipantId", "status");

-- CreateIndex
CREATE INDEX "HydraDecommit_status_updatedAt_idx" ON "HydraDecommit"("status", "updatedAt");

-- CreateIndex
CREATE INDEX "HydraDecommit_hydraHeadId_idx" ON "HydraDecommit"("hydraHeadId");

-- CreateIndex
CREATE INDEX "HydraDecommit_decommitTxId_idx" ON "HydraDecommit"("decommitTxId");

-- AddForeignKey
ALTER TABLE "HydraDecommit" ADD CONSTRAINT "HydraDecommit_hydraHeadId_fkey" FOREIGN KEY ("hydraHeadId") REFERENCES "HydraHead"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HydraDecommit" ADD CONSTRAINT "HydraDecommit_hydraLocalParticipantId_fkey" FOREIGN KEY ("hydraLocalParticipantId") REFERENCES "HydraLocalParticipant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
