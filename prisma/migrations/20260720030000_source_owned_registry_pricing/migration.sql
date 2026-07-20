-- V1 keeps one legacy AgentPricing child on RegistryRequest. V2 moves the
-- complete pricing relation under each SupportedPaymentSource so Cardano and
-- x402 options can be priced independently.

ALTER TABLE "AgentPricing"
ADD COLUMN "registryRequestId" TEXT,
ADD COLUMN "supportedPaymentSourceId" TEXT;

ALTER TABLE "AgentFixedPricing"
ADD COLUMN "agentPricingId" TEXT;

ALTER TABLE "SupportedPaymentSource"
ADD COLUMN "canonicalKey" TEXT,
ADD COLUMN "position" INTEGER,
ADD COLUMN "dynamicAsset" TEXT,
ADD COLUMN "dynamicDecimals" INTEGER,
ADD COLUMN "fixedDecimals" INTEGER;

-- Invert the legacy RegistryRequest -> AgentPricing relation so pricing is an
-- owned child that can be deleted with its V1 request.
UPDATE "AgentPricing" AS pricing
SET "registryRequestId" = request."id"
FROM "RegistryRequest" AS request
WHERE request."agentPricingId" = pricing."id";

-- Invert AgentPricing -> AgentFixedPricing for the same ownership semantics.
UPDATE "AgentFixedPricing" AS fixed
SET "agentPricingId" = pricing."id"
FROM "AgentPricing" AS pricing
WHERE pricing."agentFixedPricingId" = fixed."id";

-- Clone every existing source's effective pricing into a source-owned
-- AgentPricing row. Existing Cardano sources inherit the request pricing;
-- existing EVM rows already carry their own pricing columns.
INSERT INTO "AgentPricing" (
  "id",
  "createdAt",
  "updatedAt",
  "pricingType",
  "supportedPaymentSourceId"
)
SELECT
  'source-pricing-' || source."id",
  source."createdAt",
  source."updatedAt",
  CASE
    WHEN source."chain" = 'EVM' THEN COALESCE(source."pricingType", 'Fixed'::"PricingType")
    ELSE request_pricing."pricingType"
  END,
  source."id"
FROM "SupportedPaymentSource" AS source
JOIN "RegistryRequest" AS request ON request."id" = source."registryRequestId"
JOIN "AgentPricing" AS request_pricing ON request_pricing."registryRequestId" = request."id";

-- Clone fixed-pricing containers for fixed sources.
INSERT INTO "AgentFixedPricing" (
  "id",
  "createdAt",
  "updatedAt",
  "agentPricingId"
)
SELECT
  'source-fixed-' || source."id",
  source."createdAt",
  source."updatedAt",
  'source-pricing-' || source."id"
FROM "SupportedPaymentSource" AS source
JOIN "AgentPricing" AS source_pricing
  ON source_pricing."supportedPaymentSourceId" = source."id"
WHERE source_pricing."pricingType" = 'Fixed';

-- Existing x402 Fixed rows contain one asset/amount pair.
INSERT INTO "UnitValue" (
  "id",
  "createdAt",
  "updatedAt",
  "unit",
  "amount",
  "agentFixedPricingId"
)
SELECT
  'source-amount-' || source."id",
  source."createdAt",
  source."updatedAt",
  source."asset",
  source."amount",
  'source-fixed-' || source."id"
FROM "SupportedPaymentSource" AS source
JOIN "AgentPricing" AS source_pricing
  ON source_pricing."supportedPaymentSourceId" = source."id"
WHERE source."chain" = 'EVM'
  AND source_pricing."pricingType" = 'Fixed'
  AND source."asset" IS NOT NULL
  AND source."amount" IS NOT NULL;

-- Existing Cardano Fixed rows inherit the complete multi-asset basket.
INSERT INTO "UnitValue" (
  "id",
  "createdAt",
  "updatedAt",
  "unit",
  "amount",
  "agentFixedPricingId"
)
SELECT
  'source-amount-' || source."id" || '-' || amount."id",
  amount."createdAt",
  amount."updatedAt",
  amount."unit",
  amount."amount",
  'source-fixed-' || source."id"
FROM "SupportedPaymentSource" AS source
JOIN "RegistryRequest" AS request ON request."id" = source."registryRequestId"
JOIN "AgentPricing" AS request_pricing ON request_pricing."registryRequestId" = request."id"
JOIN "AgentFixedPricing" AS request_fixed ON request_fixed."agentPricingId" = request_pricing."id"
JOIN "UnitValue" AS amount ON amount."agentFixedPricingId" = request_fixed."id"
WHERE source."chain" = 'Cardano'
  AND request_pricing."pricingType" = 'Fixed';

UPDATE "SupportedPaymentSource"
SET
  "canonicalKey" = 'legacy:' || "id",
  "dynamicAsset" = CASE
    WHEN "chain" = 'EVM' AND "pricingType" = 'Dynamic' THEN LOWER("asset")
    ELSE NULL
  END,
  "dynamicDecimals" = CASE
    WHEN "chain" = 'EVM' AND "pricingType" = 'Dynamic' THEN "decimals"
    ELSE NULL
  END,
  "fixedDecimals" = CASE
    WHEN "chain" = 'EVM' AND "pricingType" = 'Fixed' THEN "decimals"
    ELSE NULL
  END;

WITH ranked_sources AS (
  SELECT
    "id",
    (
      ROW_NUMBER() OVER (
        PARTITION BY "registryRequestId"
        ORDER BY "createdAt", "id"
      ) - 1
    )::INTEGER AS "position"
  FROM "SupportedPaymentSource"
)
UPDATE "SupportedPaymentSource" AS source
SET "position" = ranked."position"
FROM ranked_sources AS ranked
WHERE source."id" = ranked."id";

-- Remove impossible orphan fixed-pricing containers before making the inverse
-- relation required.
DELETE FROM "UnitValue"
WHERE "agentFixedPricingId" IN (
  SELECT "id" FROM "AgentFixedPricing" WHERE "agentPricingId" IS NULL
);
DELETE FROM "AgentFixedPricing" WHERE "agentPricingId" IS NULL;

ALTER TABLE "RegistryRequest"
DROP CONSTRAINT IF EXISTS "RegistryRequest_agentPricingId_fkey";
ALTER TABLE "AgentPricing"
DROP CONSTRAINT IF EXISTS "AgentPricing_agentFixedPricingId_fkey";
ALTER TABLE "UnitValue"
DROP CONSTRAINT IF EXISTS "UnitValue_agentFixedPricingId_fkey";

DROP INDEX IF EXISTS "RegistryRequest_agentPricingId_key";
DROP INDEX IF EXISTS "AgentPricing_agentFixedPricingId_key";
DROP INDEX IF EXISTS "SupportedPaymentSource_registryRequestId_chain_network_paymentSourceType_address_key";
DROP INDEX IF EXISTS "SupportedPaymentSource_x402_unique_key";

ALTER TABLE "RegistryRequest" DROP COLUMN "agentPricingId";
ALTER TABLE "AgentPricing" DROP COLUMN "agentFixedPricingId";
ALTER TABLE "AgentFixedPricing" ALTER COLUMN "agentPricingId" SET NOT NULL;
ALTER TABLE "SupportedPaymentSource" ALTER COLUMN "canonicalKey" SET NOT NULL;
ALTER TABLE "SupportedPaymentSource" ALTER COLUMN "position" SET NOT NULL;

CREATE UNIQUE INDEX "AgentPricing_registryRequestId_key"
ON "AgentPricing"("registryRequestId");
CREATE UNIQUE INDEX "AgentPricing_supportedPaymentSourceId_key"
ON "AgentPricing"("supportedPaymentSourceId");
CREATE UNIQUE INDEX "AgentFixedPricing_agentPricingId_key"
ON "AgentFixedPricing"("agentPricingId");
CREATE UNIQUE INDEX "SupportedPaymentSource_registryRequestId_canonicalKey_key"
ON "SupportedPaymentSource"("registryRequestId", "canonicalKey");
CREATE UNIQUE INDEX "SupportedPaymentSource_registryRequestId_position_key"
ON "SupportedPaymentSource"("registryRequestId", "position");

ALTER TABLE "AgentPricing"
ADD CONSTRAINT "AgentPricing_registryRequestId_fkey"
FOREIGN KEY ("registryRequestId") REFERENCES "RegistryRequest"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "AgentPricing"
ADD CONSTRAINT "AgentPricing_supportedPaymentSourceId_fkey"
FOREIGN KEY ("supportedPaymentSourceId") REFERENCES "SupportedPaymentSource"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "AgentFixedPricing"
ADD CONSTRAINT "AgentFixedPricing_agentPricingId_fkey"
FOREIGN KEY ("agentPricingId") REFERENCES "AgentPricing"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "UnitValue"
ADD CONSTRAINT "UnitValue_agentFixedPricingId_fkey"
FOREIGN KEY ("agentFixedPricingId") REFERENCES "AgentFixedPricing"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

-- V2 no longer owns a top-level compatibility price. Source-owned clones above
-- already contain the effective Cardano and x402 pricing.
DELETE FROM "AgentPricing"
WHERE "registryRequestId" IN (
  SELECT "id" FROM "RegistryRequest" WHERE "metadataVersion" >= 2
);

-- V1 never advertises source-local payment options. Remove historical
-- cross-listing rows now that the V1/V2 storage contract is strict.
DELETE FROM "SupportedPaymentSource"
WHERE "registryRequestId" IN (
  SELECT "id" FROM "RegistryRequest" WHERE "metadataVersion" < 2
);

-- Remove stale pricing rows left by historical update swaps.
DELETE FROM "AgentPricing"
WHERE "registryRequestId" IS NULL
  AND "supportedPaymentSourceId" IS NULL;

ALTER TABLE "AgentPricing"
ADD CONSTRAINT "AgentPricing_exactly_one_owner_check" CHECK (
  num_nonnulls("registryRequestId", "supportedPaymentSourceId") = 1
);

ALTER TABLE "SupportedPaymentSource"
DROP CONSTRAINT IF EXISTS "SupportedPaymentSource_completeness_check";

ALTER TABLE "SupportedPaymentSource"
DROP COLUMN "pricingType",
DROP COLUMN "asset",
DROP COLUMN "amount",
DROP COLUMN "decimals";

ALTER TABLE "SupportedPaymentSource"
ADD CONSTRAINT "SupportedPaymentSource_completeness_check" CHECK (
  (
    "chain" = 'Cardano'
    AND "paymentSourceType" IS NOT NULL
    AND "scheme" IS NULL
    AND "payTo" IS NULL
    AND "dynamicAsset" IS NULL
    AND "dynamicDecimals" IS NULL
    AND "fixedDecimals" IS NULL
  )
  OR (
    "chain" = 'EVM'
    AND "paymentSourceType" IS NULL
    AND "scheme" IS NOT NULL
    AND "payTo" IS NOT NULL
    AND (
      ("dynamicAsset" IS NULL AND "dynamicDecimals" IS NULL)
      OR ("dynamicAsset" IS NOT NULL AND "dynamicDecimals" IS NOT NULL)
    )
  )
);
