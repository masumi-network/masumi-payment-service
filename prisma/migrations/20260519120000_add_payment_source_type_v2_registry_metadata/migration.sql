-- Add canonical source typing for V1/V2 payment-source dispatch.
-- Postgres doesn't accept `CREATE TYPE IF NOT EXISTS`, so guard with a
-- duplicate_object catch so re-running this migration on a database that
-- already applied it (manual replays, partial recoveries) is a no-op.
DO $$ BEGIN
    CREATE TYPE "PaymentSourceType" AS ENUM ('Web3CardanoV1', 'Web3CardanoV2');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

ALTER TABLE "PaymentSource"
ADD COLUMN IF NOT EXISTS "paymentSourceType" "PaymentSourceType" NOT NULL DEFAULT 'Web3CardanoV1',
ADD COLUMN IF NOT EXISTS "requiredAdminSignatures" INTEGER,
ALTER COLUMN "adminWalletId" DROP NOT NULL;

-- Drop the strict unique on (network, policyId). Active-source uniqueness now lives in
-- @@unique([network, smartContractAddress]); multiple V2 sources per network are allowed
-- and disambiguated by smartContractAddress carried in the signed V2 identifier.
DROP INDEX IF EXISTS "PaymentSource_network_policyId_key";
CREATE INDEX IF NOT EXISTS "PaymentSource_network_policyId_idx"
ON "PaymentSource"("network", "policyId");

-- V2 keeps return-address intent with the request rows.
ALTER TABLE "PaymentRequest"
ADD COLUMN IF NOT EXISTS "buyerReturnAddress" TEXT,
ADD COLUMN IF NOT EXISTS "sellerReturnAddress" TEXT;

ALTER TABLE "PurchaseRequest"
ADD COLUMN IF NOT EXISTS "buyerReturnAddress" TEXT,
ADD COLUMN IF NOT EXISTS "sellerReturnAddress" TEXT;

-- V2 contract state/action extensions.
ALTER TYPE "OnChainState" ADD VALUE IF NOT EXISTS 'WithdrawAuthorized';
ALTER TYPE "OnChainState" ADD VALUE IF NOT EXISTS 'RefundAuthorized';

ALTER TYPE "PurchasingAction" ADD VALUE IF NOT EXISTS 'AuthorizeWithdrawalRequested';
ALTER TYPE "PurchasingAction" ADD VALUE IF NOT EXISTS 'AuthorizeWithdrawalInitiated';

-- Supported payment sources advertised by a registry entry: persisted as rows in a
-- dedicated child table, not as JSON. Mirrors the on-chain registry metadata.
DO $$ BEGIN
    CREATE TYPE "Chain" AS ENUM ('Cardano');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

CREATE TABLE IF NOT EXISTS "SupportedPaymentSource" (
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

CREATE UNIQUE INDEX IF NOT EXISTS "SupportedPaymentSource_registryRequestId_chain_network_paymentSourceType_address_key"
ON "SupportedPaymentSource"("registryRequestId", "chain", "network", "paymentSourceType", "address");

CREATE INDEX IF NOT EXISTS "SupportedPaymentSource_address_idx"
ON "SupportedPaymentSource"("address");

CREATE INDEX IF NOT EXISTS "SupportedPaymentSource_paymentSourceType_idx"
ON "SupportedPaymentSource"("paymentSourceType");

-- Idempotent FK install: ALTER TABLE ... ADD CONSTRAINT has no IF NOT EXISTS,
-- so guard via the catalog.
DO $$ BEGIN
    ALTER TABLE "SupportedPaymentSource"
    ADD CONSTRAINT "SupportedPaymentSource_registryRequestId_fkey"
    FOREIGN KEY ("registryRequestId") REFERENCES "RegistryRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

-- Backfill: every existing RegistryRequest tagged as Web3CardanoV1 gets one
-- SupportedPaymentSource row derived from its linked PaymentSource. None-typed rows
-- keep an empty relation (the canonical "no payment metadata" representation).
-- Backfill: every existing RegistryRequest gets one SupportedPaymentSource row
-- derived from its linked PaymentSource. The legacy "paymentType" column on
-- RegistryRequest was removed in 20260410103222_remove_unused_payment_type, so
-- we can no longer filter by it. Before this migration, V2 did not exist; every
-- existing RegistryRequest therefore corresponds to Web3CardanoV1 by definition.
-- Rows whose linked PaymentSource was deleted are skipped by the INNER JOIN.
--
-- M12: emit a NOTICE when the inner join silently drops rows because their
-- linked PaymentSource no longer exists. Catching this at deploy time turns an
-- otherwise invisible data-integrity drift into a visible signal in the
-- migrate log. We do not abort: orphan registry rows are recoverable manually
-- and an in-place migration should not block deploy on cleanup work.
DO $$
DECLARE
    expected_count INT;
    inserted_count INT;
    orphan_count INT;
BEGIN
    SELECT COUNT(*) INTO expected_count
    FROM "RegistryRequest" rr
    WHERE rr."paymentSourceId" IS NOT NULL;

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

    GET DIAGNOSTICS inserted_count = ROW_COUNT;
    orphan_count := expected_count - inserted_count;

    IF orphan_count > 0 THEN
        RAISE NOTICE 'SupportedPaymentSource backfill: % rows inserted, % registry rows expected (% orphan(s) skipped due to missing PaymentSource).',
            inserted_count, expected_count, orphan_count;
    END IF;
END $$;

-- Post-backfill verification (run manually if validating a deploy):
--   SELECT
--     (SELECT COUNT(*) FROM "RegistryRequest" rr
--        JOIN "PaymentSource" ps ON rr."paymentSourceId" = ps.id) AS expected,
--     (SELECT COUNT(*) FROM "SupportedPaymentSource") AS actual;
-- expected and actual should match. Drift indicates an orphan registry entry
-- whose paymentSourceId references a deleted PaymentSource and needs
-- investigation.
