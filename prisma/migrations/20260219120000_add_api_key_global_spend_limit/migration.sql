-- AlterTable
ALTER TABLE "ApiKey" ADD COLUMN "globalSpendLimit" BIGINT,
                     ADD COLUMN "totalADASpent" BIGINT NOT NULL DEFAULT 0;
