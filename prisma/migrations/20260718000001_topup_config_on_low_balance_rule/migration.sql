-- Move the auto-top-up policy onto the wallet that runs low.
--
-- A HotWalletLowBalanceRule already fires the low-balance alert/webhook when the
-- balance drops below thresholdAmount. It can now optionally also trigger a
-- top-up: `topupEnabled` turns it on, `topupAmount` is how much (in the asset's
-- smallest unit). A fund wallet on the same source provides the funds.

-- AlterTable: add the top-up trigger config to the low-balance rule.
ALTER TABLE "HotWalletLowBalanceRule"
    ADD COLUMN "topupEnabled" BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN "topupAmount" BIGINT;

-- Auto-top-up now has one batched tier. Preserve queued work created by the
-- previous warning/critical policy while normalizing it to the tier the new
-- dispatcher creates.
UPDATE "FundDistributionRequest"
SET "priority" = 'Warning'
WHERE "status" = 'Pending'
  AND "priority" = 'Critical';

-- The fund wallet no longer owns per-asset thresholds/amounts, so its asset
-- policy table is dropped. Clean cutover: operators reconfigure auto-top-up on
-- each hot wallet's low-balance rules.
DROP TABLE "FundDistributionAssetConfig";
