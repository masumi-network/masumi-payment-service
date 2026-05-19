-- Add canonical source typing for V1/V2 payment-source dispatch.
CREATE TYPE "PaymentSourceType" AS ENUM ('Web3CardanoV1', 'Web3CardanoV2');

ALTER TABLE "PaymentSource"
ADD COLUMN "paymentSourceType" "PaymentSourceType" NOT NULL DEFAULT 'Web3CardanoV1',
ADD COLUMN "requiredAdminSignatures" INTEGER,
ALTER COLUMN "adminWalletId" DROP NOT NULL;

-- Active-source uniqueness is partial because retired sources keep historical rows.
DROP INDEX IF EXISTS "PaymentSource_network_policyId_key";
CREATE INDEX "PaymentSource_network_policyId_idx"
ON "PaymentSource"("network", "policyId");

CREATE UNIQUE INDEX "PaymentSource_active_network_policyId_key"
ON "PaymentSource"("network", "policyId")
WHERE "policyId" IS NOT NULL AND "deletedAt" IS NULL;

CREATE UNIQUE INDEX "PaymentSource_active_v2_network_key"
ON "PaymentSource"("network")
WHERE "paymentSourceType" = 'Web3CardanoV2' AND "deletedAt" IS NULL;

-- V2 keeps return-address intent with the request rows.
ALTER TABLE "PaymentRequest"
ADD COLUMN "buyerReturnAddress" TEXT,
ADD COLUMN "sellerReturnAddress" TEXT;

ALTER TABLE "PurchaseRequest"
ADD COLUMN "buyerReturnAddress" TEXT,
ADD COLUMN "sellerReturnAddress" TEXT;

-- Regular registry metadata v2 advertises supported payment sources.
ALTER TABLE "RegistryRequest"
ADD COLUMN "supportedPaymentSources" JSONB;

-- V2 contract state/action extensions.
ALTER TYPE "OnChainState" ADD VALUE IF NOT EXISTS 'WithdrawAuthorized';
ALTER TYPE "OnChainState" ADD VALUE IF NOT EXISTS 'RefundAuthorized';

ALTER TYPE "PurchasingAction" ADD VALUE IF NOT EXISTS 'AuthorizeWithdrawalRequested';
ALTER TYPE "PurchasingAction" ADD VALUE IF NOT EXISTS 'AuthorizeWithdrawalInitiated';
