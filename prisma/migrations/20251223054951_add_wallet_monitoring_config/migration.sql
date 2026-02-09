-- CreateTable
CREATE TABLE "WalletMonitorConfig" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "paymentSourceId" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "checkIntervalSeconds" INTEGER NOT NULL DEFAULT 3600,
    "lastCheckedAt" TIMESTAMP(3),
    "lastCheckStatus" TEXT,
    "lastCheckError" TEXT,

    CONSTRAINT "WalletMonitorConfig_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WalletThreshold" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "hotWalletId" TEXT NOT NULL,
    "walletMonitorConfigId" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "adaThresholdLovelace" BIGINT NOT NULL DEFAULT 10000000,

    CONSTRAINT "WalletThreshold_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AssetThreshold" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "walletThresholdId" TEXT NOT NULL,
    "policyId" TEXT NOT NULL,
    "assetName" TEXT NOT NULL,
    "displayName" TEXT,
    "displaySymbol" TEXT,
    "decimals" INTEGER NOT NULL DEFAULT 0,
    "minAmount" BIGINT NOT NULL,

    CONSTRAINT "AssetThreshold_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "WalletMonitorConfig_paymentSourceId_key" ON "WalletMonitorConfig"("paymentSourceId");

-- CreateIndex
CREATE INDEX "WalletMonitorConfig_enabled_lastCheckedAt_idx" ON "WalletMonitorConfig"("enabled", "lastCheckedAt");

-- CreateIndex
CREATE INDEX "WalletThreshold_enabled_idx" ON "WalletThreshold"("enabled");

-- CreateIndex
CREATE UNIQUE INDEX "WalletThreshold_hotWalletId_walletMonitorConfigId_key" ON "WalletThreshold"("hotWalletId", "walletMonitorConfigId");

-- CreateIndex
CREATE INDEX "AssetThreshold_policyId_assetName_idx" ON "AssetThreshold"("policyId", "assetName");

-- CreateIndex
CREATE UNIQUE INDEX "AssetThreshold_walletThresholdId_policyId_assetName_key" ON "AssetThreshold"("walletThresholdId", "policyId", "assetName");

-- AddForeignKey
ALTER TABLE "WalletMonitorConfig" ADD CONSTRAINT "WalletMonitorConfig_paymentSourceId_fkey" FOREIGN KEY ("paymentSourceId") REFERENCES "PaymentSource"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WalletThreshold" ADD CONSTRAINT "WalletThreshold_hotWalletId_fkey" FOREIGN KEY ("hotWalletId") REFERENCES "HotWallet"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WalletThreshold" ADD CONSTRAINT "WalletThreshold_walletMonitorConfigId_fkey" FOREIGN KEY ("walletMonitorConfigId") REFERENCES "WalletMonitorConfig"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AssetThreshold" ADD CONSTRAINT "AssetThreshold_walletThresholdId_fkey" FOREIGN KEY ("walletThresholdId") REFERENCES "WalletThreshold"("id") ON DELETE CASCADE ON UPDATE CASCADE;
