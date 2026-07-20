-- Allow multiple active fund wallets per payment source (redundancy / capacity):
-- any fund wallet on the source can fund any shortage, so a distribution request
-- is recorded per (target, asset) and unassigned until dispatch picks the first
-- wallet with funds.

-- Drop the "one active fund wallet per payment source" partial unique index.
-- Prisma cannot express partial indexes, so this is a raw statement (the index
-- was created the same way in 20260717000000_enforce_active_fund_wallet_uniqueness).
DROP INDEX "HotWallet_active_funding_paymentSourceId_key";

-- fundWalletId becomes nullable: a request is unassigned until a fund wallet
-- claims it at dispatch. Re-point the FK to ON DELETE SET NULL so removing a
-- fund wallet releases its unclaimed requests back to the pool.
ALTER TABLE "FundDistributionRequest" DROP CONSTRAINT "FundDistributionRequest_fundWalletId_fkey";

DROP INDEX "FundDistributionRequest_fundWalletId_targetWalletId_assetUn_idx";

ALTER TABLE "FundDistributionRequest" ALTER COLUMN "fundWalletId" DROP NOT NULL;

-- Requests queued under the previous model already have a fund wallet even
-- though no transaction has claimed them. The new dispatcher deliberately
-- selects only unassigned rows, so release those requests during the cutover.
-- A row linked to a Transaction is in flight and remains assigned for
-- reconciliation.
UPDATE "FundDistributionRequest"
SET "fundWalletId" = NULL
WHERE "status" = 'Pending'
  AND "transactionId" IS NULL;

-- Dedupe is now per (target, asset) across all fund wallets on the source.
CREATE INDEX "FundDistributionRequest_targetWalletId_assetUnit_status_idx" ON "FundDistributionRequest"("targetWalletId", "assetUnit", "status");

ALTER TABLE "FundDistributionRequest" ADD CONSTRAINT "FundDistributionRequest_fundWalletId_fkey" FOREIGN KEY ("fundWalletId") REFERENCES "HotWallet"("id") ON DELETE SET NULL ON UPDATE CASCADE;
