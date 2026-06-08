-- CreateEnum
CREATE TYPE "FundDistributionPriority" AS ENUM ('Warning', 'Critical');

-- CreateEnum
CREATE TYPE "FundDistributionStatus" AS ENUM ('Pending', 'Submitted', 'Confirmed', 'Failed');

-- AlterEnum
ALTER TYPE "HotWalletType" ADD VALUE 'Funding';

-- AlterEnum
ALTER TYPE "WebhookEventType" ADD VALUE 'FUND_DISTRIBUTION_SENT';

-- CreateTable
CREATE TABLE "FundDistributionConfig" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "hotWalletId" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "warningThreshold" BIGINT NOT NULL,
    "criticalThreshold" BIGINT NOT NULL,
    "topupAmount" BIGINT NOT NULL,
    "batchWindowMs" INTEGER NOT NULL DEFAULT 300000,

    CONSTRAINT "FundDistributionConfig_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FundDistributionRequest" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "fundWalletId" TEXT NOT NULL,
    "targetWalletId" TEXT NOT NULL,
    "priority" "FundDistributionPriority" NOT NULL,
    "amount" BIGINT NOT NULL,
    "status" "FundDistributionStatus" NOT NULL DEFAULT 'Pending',
    "txHash" TEXT,
    "error" TEXT,
    "batchId" TEXT,

    CONSTRAINT "FundDistributionRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "FundDistributionConfig_hotWalletId_key" ON "FundDistributionConfig"("hotWalletId");

-- CreateIndex
CREATE INDEX "FundDistributionRequest_fundWalletId_status_idx" ON "FundDistributionRequest"("fundWalletId", "status");

-- CreateIndex
CREATE INDEX "FundDistributionRequest_status_priority_createdAt_idx" ON "FundDistributionRequest"("status", "priority", "createdAt");

-- CreateIndex
CREATE INDEX "FundDistributionRequest_fundWalletId_targetWalletId_status_idx" ON "FundDistributionRequest"("fundWalletId", "targetWalletId", "status");

-- AddForeignKey
ALTER TABLE "FundDistributionConfig" ADD CONSTRAINT "FundDistributionConfig_hotWalletId_fkey" FOREIGN KEY ("hotWalletId") REFERENCES "HotWallet"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FundDistributionRequest" ADD CONSTRAINT "FundDistributionRequest_fundWalletId_fkey" FOREIGN KEY ("fundWalletId") REFERENCES "HotWallet"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FundDistributionRequest" ADD CONSTRAINT "FundDistributionRequest_targetWalletId_fkey" FOREIGN KEY ("targetWalletId") REFERENCES "HotWallet"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- CreateIndex
CREATE INDEX "FundDistributionRequest_status_updatedAt_idx" ON "FundDistributionRequest"("status", "updatedAt");
