-- Give each x402 registry source its own pricing type.
-- Existing rows were fixed-price by construction, so preserve that meaning.
--
-- NOT rolling-deploy safe: this migration chain (20260720000000..030000)
-- adds CHECKs the pre-migration app violates on insert and later drops
-- columns it reads. Deploy stop-the-world: stop old instances, migrate,
-- start new instances.
ALTER TABLE "SupportedPaymentSource"
ADD COLUMN "pricingType" "PricingType";

UPDATE "SupportedPaymentSource"
SET "pricingType" = 'Fixed'
WHERE "chain" = 'EVM';

DROP INDEX IF EXISTS "SupportedPaymentSource_x402_unique_key";

CREATE UNIQUE INDEX "SupportedPaymentSource_x402_unique_key"
ON "SupportedPaymentSource"(
  "registryRequestId",
  "chain",
  "network",
  "scheme",
  "pricingType",
  COALESCE("asset", ''),
  COALESCE("amount", -1),
  COALESCE("decimals", -1),
  "payTo",
  COALESCE("resource", '')
)
WHERE "chain" = 'EVM' AND "scheme" IS NOT NULL AND "payTo" IS NOT NULL;

ALTER TABLE "SupportedPaymentSource"
DROP CONSTRAINT IF EXISTS "SupportedPaymentSource_completeness_check";

ALTER TABLE "SupportedPaymentSource"
ADD CONSTRAINT "SupportedPaymentSource_completeness_check" CHECK (
  (
    "chain" = 'Cardano'
    AND "paymentSourceType" IS NOT NULL
    AND "pricingType" IS NULL
  )
  OR (
    "chain" = 'EVM'
    AND "scheme" IS NOT NULL
    AND "pricingType" IS NOT NULL
    AND "payTo" IS NOT NULL
    AND (
      (
        "pricingType" = 'Fixed'
        AND "asset" IS NOT NULL
        AND "amount" IS NOT NULL
        AND "decimals" IS NOT NULL
      )
      OR (
        "pricingType" = 'Dynamic'
        AND "amount" IS NULL
        AND (
          ("asset" IS NULL AND "decimals" IS NULL)
          OR ("asset" IS NOT NULL AND "decimals" IS NOT NULL)
        )
      )
      OR (
        "pricingType" = 'Free'
        AND "asset" IS NULL
        AND "amount" IS NULL
        AND "decimals" IS NULL
      )
    )
  )
);
