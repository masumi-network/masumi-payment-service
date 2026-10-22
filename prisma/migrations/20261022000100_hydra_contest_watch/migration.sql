-- AlterEnum
ALTER TYPE "WebhookEventType" ADD VALUE 'HYDRA_HEAD_CONTEST_MISSING';

-- AlterEnum
ALTER TYPE "HydraErrorType" ADD VALUE 'ContestMissing';

-- AlterTable
ALTER TABLE "HydraHead" ADD COLUMN "contestGapAlertedAt" TIMESTAMP(3),
ADD COLUMN "contestGapSignature" TEXT,
ADD COLUMN "contestGapSince" TIMESTAMP(3);
