-- AlterEnum
ALTER TYPE "WebhookEventType" ADD VALUE 'HYDRA_HEAD_SNAPSHOT_ROUND_STUCK';

-- AlterTable
ALTER TABLE "HydraHead" ADD COLUMN     "snapshotRoundAlertedAt" TIMESTAMP(3),
ADD COLUMN     "snapshotRoundSignature" TEXT,
ADD COLUMN     "snapshotRoundSince" TIMESTAMP(3);
