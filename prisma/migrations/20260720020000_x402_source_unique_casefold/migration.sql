-- EVM addresses are case-insensitive. Rebuild the partial uniqueness index
-- with canonical address expressions so mixed-case spellings cannot create
-- duplicate registry payment options.
DROP INDEX IF EXISTS "SupportedPaymentSource_x402_unique_key";

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
