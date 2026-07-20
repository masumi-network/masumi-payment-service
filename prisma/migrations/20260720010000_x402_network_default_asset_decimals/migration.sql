ALTER TABLE "X402Network"
ADD COLUMN "defaultAssetDecimals" INTEGER;

-- Backfill only assets whose decimals are known. Unknown legacy defaults stay
-- unset and must be confirmed by an operator before the registration UI uses
-- them for human-readable fixed-price conversion.
UPDATE "X402Network"
SET "defaultAssetDecimals" = 6
WHERE ("caip2Id", LOWER("defaultAsset")) IN (
  ('eip155:1', '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'),
  ('eip155:11155111', '0x1c7d4b196cb0c7b01d743fbc6116a902379c7238'),
  ('eip155:8453', '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'),
  ('eip155:84532', '0x036cbd53842c5426634e7929541ec2318f3dcf7c')
);

ALTER TABLE "X402Network"
ADD CONSTRAINT "X402Network_default_asset_decimals_check" CHECK (
  "defaultAssetDecimals" IS NULL
  OR (
    "defaultAsset" IS NOT NULL
    AND "defaultAssetDecimals" >= 0
    AND "defaultAssetDecimals" <= 255
  )
);
