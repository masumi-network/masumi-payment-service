-- AlterEnum
ALTER TYPE "WebhookEventType" ADD VALUE 'HYDRA_HEAD_LOW_BALANCE';

-- CreateTable
CREATE TABLE "HydraLowBalanceRule" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "hydraLocalParticipantId" TEXT NOT NULL,
    "assetUnit" TEXT NOT NULL,
    "thresholdAmount" BIGINT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "topupEnabled" BOOLEAN NOT NULL DEFAULT false,
    "topupAmount" BIGINT,
    "status" "LowBalanceStatus" NOT NULL DEFAULT 'Unknown',
    "lastKnownAmount" BIGINT,
    "lastCheckedAt" TIMESTAMP(3),
    "lastAlertedAt" TIMESTAMP(3),

    CONSTRAINT "HydraLowBalanceRule_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "HydraLowBalanceRule_hydraLocalParticipantId_enabled_idx" ON "HydraLowBalanceRule"("hydraLocalParticipantId", "enabled");

-- CreateIndex
CREATE INDEX "HydraLowBalanceRule_enabled_status_idx" ON "HydraLowBalanceRule"("enabled", "status");

-- CreateIndex
CREATE UNIQUE INDEX "HydraLowBalanceRule_hydraLocalParticipantId_assetUnit_key" ON "HydraLowBalanceRule"("hydraLocalParticipantId", "assetUnit");

-- AddForeignKey
ALTER TABLE "HydraLowBalanceRule" ADD CONSTRAINT "HydraLowBalanceRule_hydraLocalParticipantId_fkey" FOREIGN KEY ("hydraLocalParticipantId") REFERENCES "HydraLocalParticipant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
