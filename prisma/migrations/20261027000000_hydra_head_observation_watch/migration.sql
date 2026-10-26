-- AlterEnum
ALTER TYPE "WebhookEventType" ADD VALUE 'HYDRA_HEAD_UNOBSERVED';

-- AlterEnum
ALTER TYPE "HydraErrorType" ADD VALUE 'HeadUnobserved';

-- AlterTable
ALTER TABLE "HydraHead" ADD COLUMN "observationCheckedAt" TIMESTAMP(3),
ADD COLUMN "observationGapAlertedAt" TIMESTAMP(3),
ADD COLUMN "observationGapAlertedNodeSide" BOOLEAN,
ADD COLUMN "observationGapSince" TIMESTAMP(3);
