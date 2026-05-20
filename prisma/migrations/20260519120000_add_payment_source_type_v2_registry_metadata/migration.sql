-- Add canonical source typing for V1/V2 payment-source dispatch.
CREATE TYPE "PaymentSourceType" AS ENUM ('Web3CardanoV1', 'Web3CardanoV2');

ALTER TABLE "PaymentSource"
ADD COLUMN "paymentSourceType" "PaymentSourceType" NOT NULL DEFAULT 'Web3CardanoV1',
ADD COLUMN "requiredAdminSignatures" INTEGER,
ALTER COLUMN "adminWalletId" DROP NOT NULL;

-- Drop the strict unique on (network, policyId). Active-source uniqueness now lives in
-- @@unique([network, smartContractAddress]); multiple V2 sources per network are allowed
-- and disambiguated by smartContractAddress carried in the signed V2 identifier.
DROP INDEX IF EXISTS "PaymentSource_network_policyId_key";
CREATE INDEX "PaymentSource_network_policyId_idx"
ON "PaymentSource"("network", "policyId");

-- V2 keeps return-address intent with the request rows.
ALTER TABLE "PaymentRequest"
ADD COLUMN "buyerReturnAddress" TEXT,
ADD COLUMN "sellerReturnAddress" TEXT;

ALTER TABLE "PurchaseRequest"
ADD COLUMN "buyerReturnAddress" TEXT,
ADD COLUMN "sellerReturnAddress" TEXT;

-- V2 contract state/action extensions.
ALTER TYPE "OnChainState" ADD VALUE IF NOT EXISTS 'WithdrawAuthorized';
ALTER TYPE "OnChainState" ADD VALUE IF NOT EXISTS 'RefundAuthorized';

ALTER TYPE "PurchasingAction" ADD VALUE IF NOT EXISTS 'AuthorizeWithdrawalRequested';
ALTER TYPE "PurchasingAction" ADD VALUE IF NOT EXISTS 'AuthorizeWithdrawalInitiated';

-- Supported payment sources advertised by a registry entry: persisted as rows in a
-- dedicated child table, not as JSON. Mirrors the on-chain registry metadata.
CREATE TYPE "Chain" AS ENUM ('Cardano');

CREATE TABLE "SupportedPaymentSource" (
    "id"                TEXT NOT NULL,
    "createdAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"         TIMESTAMP(3) NOT NULL,
    "registryRequestId" TEXT NOT NULL,
    "chain"             "Chain" NOT NULL,
    "network"           "Network" NOT NULL,
    "paymentSourceType" "PaymentSourceType" NOT NULL,
    "address"           TEXT NOT NULL,

    CONSTRAINT "SupportedPaymentSource_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "SupportedPaymentSource_registryRequestId_chain_network_paymentSourceType_address_key"
ON "SupportedPaymentSource"("registryRequestId", "chain", "network", "paymentSourceType", "address");

CREATE INDEX "SupportedPaymentSource_address_idx"
ON "SupportedPaymentSource"("address");

CREATE INDEX "SupportedPaymentSource_paymentSourceType_idx"
ON "SupportedPaymentSource"("paymentSourceType");

ALTER TABLE "SupportedPaymentSource"
ADD CONSTRAINT "SupportedPaymentSource_registryRequestId_fkey"
FOREIGN KEY ("registryRequestId") REFERENCES "RegistryRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Backfill: every existing RegistryRequest tagged as Web3CardanoV1 gets one
-- SupportedPaymentSource row derived from its linked PaymentSource. None-typed rows
-- keep an empty relation (the canonical "no payment metadata" representation).
-- Backfill: every existing RegistryRequest gets one SupportedPaymentSource row
-- derived from its linked PaymentSource. The legacy "paymentType" column on
-- RegistryRequest was removed in 20260410103222_remove_unused_payment_type, so
-- we can no longer filter by it. Before this migration, V2 did not exist; every
-- existing RegistryRequest therefore corresponds to Web3CardanoV1 by definition.
-- Rows whose linked PaymentSource was deleted are skipped by the INNER JOIN.
INSERT INTO "SupportedPaymentSource" ("id", "createdAt", "updatedAt", "registryRequestId", "chain", "network", "paymentSourceType", "address")
SELECT
    'sps_' || rr.id,
    NOW(),
    NOW(),
    rr.id,
    'Cardano'::"Chain",
    ps.network,
    'Web3CardanoV1'::"PaymentSourceType",
    ps."smartContractAddress"
FROM "RegistryRequest" rr
JOIN "PaymentSource" ps ON rr."paymentSourceId" = ps.id
ON CONFLICT DO NOTHING;

-- Post-backfill verification (run manually if validating a deploy):
--   SELECT
--     (SELECT COUNT(*) FROM "RegistryRequest" rr
--        JOIN "PaymentSource" ps ON rr."paymentSourceId" = ps.id) AS expected,
--     (SELECT COUNT(*) FROM "SupportedPaymentSource") AS actual;
-- expected and actual should match. Drift indicates an orphan registry entry
-- whose paymentSourceId references a deleted PaymentSource and needs
-- investigation.
