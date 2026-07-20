-- EVM addresses are case-insensitive. Rebuild the partial uniqueness index
-- with canonical address expressions so mixed-case spellings cannot create
-- duplicate registry payment options.
DROP INDEX IF EXISTS "SupportedPaymentSource_x402_unique_key";

-- The previous index compared address text case-sensitively, so an existing
-- registry request may already contain multiple spellings of the same logical
-- EVM option. Preserve attempt history by repointing it to the oldest canonical
-- row, then remove duplicates before normalizing the surviving addresses.
WITH ranked AS (
  SELECT
    "id",
    FIRST_VALUE("id") OVER (
      PARTITION BY
        "registryRequestId",
        "chain",
        "network",
        "scheme",
        "pricingType",
        LOWER(COALESCE("asset", '')),
        COALESCE("amount", -1),
        COALESCE("decimals", -1),
        LOWER("payTo"),
        COALESCE("resource", '')
      ORDER BY "createdAt", "id"
    ) AS "canonicalId",
    ROW_NUMBER() OVER (
      PARTITION BY
        "registryRequestId",
        "chain",
        "network",
        "scheme",
        "pricingType",
        LOWER(COALESCE("asset", '')),
        COALESCE("amount", -1),
        COALESCE("decimals", -1),
        LOWER("payTo"),
        COALESCE("resource", '')
      ORDER BY "createdAt", "id"
    ) AS "duplicateRank"
  FROM "SupportedPaymentSource"
  WHERE "chain" = 'EVM' AND "scheme" IS NOT NULL AND "payTo" IS NOT NULL
)
UPDATE "X402PaymentAttempt" AS attempt
SET "supportedPaymentSourceId" = ranked."canonicalId"
FROM ranked
WHERE ranked."duplicateRank" > 1
  AND attempt."supportedPaymentSourceId" = ranked."id";

WITH ranked AS (
  SELECT
    "id",
    ROW_NUMBER() OVER (
      PARTITION BY
        "registryRequestId",
        "chain",
        "network",
        "scheme",
        "pricingType",
        LOWER(COALESCE("asset", '')),
        COALESCE("amount", -1),
        COALESCE("decimals", -1),
        LOWER("payTo"),
        COALESCE("resource", '')
      ORDER BY "createdAt", "id"
    ) AS "duplicateRank"
  FROM "SupportedPaymentSource"
  WHERE "chain" = 'EVM' AND "scheme" IS NOT NULL AND "payTo" IS NOT NULL
)
DELETE FROM "SupportedPaymentSource" AS source
USING ranked
WHERE ranked."duplicateRank" > 1
  AND source."id" = ranked."id";

UPDATE "SupportedPaymentSource"
SET
  "address" = LOWER("address"),
  "asset" = CASE WHEN "asset" IS NULL THEN NULL ELSE LOWER("asset") END,
  "payTo" = LOWER("payTo")
WHERE "chain" = 'EVM';

CREATE UNIQUE INDEX "SupportedPaymentSource_x402_unique_key"
ON "SupportedPaymentSource"(
  "registryRequestId",
  "chain",
  "network",
  "scheme",
  "pricingType",
  LOWER(COALESCE("asset", '')),
  COALESCE("amount", -1),
  COALESCE("decimals", -1),
  LOWER("payTo"),
  COALESCE("resource", '')
)
WHERE "chain" = 'EVM' AND "scheme" IS NOT NULL AND "payTo" IS NOT NULL;
