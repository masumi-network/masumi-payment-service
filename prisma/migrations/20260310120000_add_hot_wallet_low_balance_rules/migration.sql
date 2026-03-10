-- CreateEnum
CREATE TYPE "LowBalanceStatus" AS ENUM ('Unknown', 'Healthy', 'Low');

-- AlterEnum
ALTER TYPE "WebhookEventType" ADD VALUE 'WALLET_LOW_BALANCE';

-- CreateTable
CREATE TABLE "HotWalletLowBalanceRule" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "hotWalletId" TEXT NOT NULL,
    "assetUnit" TEXT NOT NULL,
    "thresholdAmount" BIGINT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "status" "LowBalanceStatus" NOT NULL DEFAULT 'Unknown',
    "lastKnownAmount" BIGINT,
    "lastCheckedAt" TIMESTAMP(3),
    "lastAlertedAt" TIMESTAMP(3),

    CONSTRAINT "HotWalletLowBalanceRule_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "HotWalletLowBalanceRule_hotWalletId_enabled_idx" ON "HotWalletLowBalanceRule"("hotWalletId", "enabled");

-- CreateIndex
CREATE INDEX "HotWalletLowBalanceRule_enabled_status_idx" ON "HotWalletLowBalanceRule"("enabled", "status");

-- CreateIndex
CREATE UNIQUE INDEX "HotWalletLowBalanceRule_hotWalletId_assetUnit_key" ON "HotWalletLowBalanceRule"("hotWalletId", "assetUnit");

-- AddForeignKey
ALTER TABLE "HotWalletLowBalanceRule" ADD CONSTRAINT "HotWalletLowBalanceRule_hotWalletId_fkey" FOREIGN KEY ("hotWalletId") REFERENCES "HotWallet"("id") ON DELETE CASCADE ON UPDATE CASCADE;
