-- Fund distribution becomes per-asset.
--
-- Low-balance rules are already keyed per asset (HotWalletLowBalanceRule has a
-- unique on (hotWalletId, assetUnit)), so an operator can already watch USDM or
-- USDCX. Distribution could only ever answer a lovelace shortage, so those
-- alerts fired into a top-up path that silently ignored them.
--
-- Written as a forward migration rather than an edit to
-- 20260716000000_add_fund_distribution: two later migrations already build on
-- that one, so rewriting it would break the journal for anyone who has applied
-- them.

-- CreateTable
CREATE TABLE "FundDistributionAssetConfig" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "fundDistributionConfigId" TEXT NOT NULL,
    "assetUnit" TEXT NOT NULL,
    "warningThreshold" BIGINT NOT NULL,
    "criticalThreshold" BIGINT NOT NULL,
    "topupAmount" BIGINT NOT NULL,

    CONSTRAINT "FundDistributionAssetConfig_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "FundDistributionAssetConfig_fundDistributionConfigId_assetU_key" ON "FundDistributionAssetConfig"("fundDistributionConfigId", "assetUnit");

-- CreateIndex
CREATE INDEX "FundDistributionAssetConfig_assetUnit_idx" ON "FundDistributionAssetConfig"("assetUnit");

-- AddForeignKey
ALTER TABLE "FundDistributionAssetConfig" ADD CONSTRAINT "FundDistributionAssetConfig_fundDistributionConfigId_fkey" FOREIGN KEY ("fundDistributionConfigId") REFERENCES "FundDistributionConfig"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Backfill: every existing config described lovelace, so carry its thresholds
-- into an explicit lovelace asset row before the columns are dropped. Uses the
-- config's own id for determinism (one asset row per config at this point), so
-- re-running cannot duplicate.
INSERT INTO "FundDistributionAssetConfig" ("id", "createdAt", "updatedAt", "fundDistributionConfigId", "assetUnit", "warningThreshold", "criticalThreshold", "topupAmount")
SELECT "id", "createdAt", "updatedAt", "id", 'lovelace', "warningThreshold", "criticalThreshold", "topupAmount"
FROM "FundDistributionConfig";

-- AlterTable: the scalar triple cannot describe more than one asset.
ALTER TABLE "FundDistributionConfig" DROP COLUMN "warningThreshold",
DROP COLUMN "criticalThreshold",
DROP COLUMN "topupAmount";

-- AlterTable: which asset a request moves. Defaulted to lovelace so existing
-- in-flight rows keep their meaning.
ALTER TABLE "FundDistributionRequest" ADD COLUMN "assetUnit" TEXT NOT NULL DEFAULT 'lovelace';

-- Dedupe is per (target, asset): an in-flight ADA top-up must not suppress a
-- USDM one to the same wallet.
DROP INDEX "FundDistributionRequest_fundWalletId_targetWalletId_status_idx";

-- CreateIndex
CREATE INDEX "FundDistributionRequest_fundWalletId_targetWalletId_assetUn_idx" ON "FundDistributionRequest"("fundWalletId", "targetWalletId", "assetUnit", "status");
