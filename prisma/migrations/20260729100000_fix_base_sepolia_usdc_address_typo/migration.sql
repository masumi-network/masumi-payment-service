-- Fix: the 20260720010000 migration's Base Sepolia USDC backfill used a
-- typo'd address (...dcf7c, no deployed contract) instead of the real
-- Circle USDC contract (...dCF7e). Any operator who set defaultAsset via
-- the admin API using the frontend's (also-typo'd) preset picked up the
-- wrong value; this corrects it (stored lowercase, matching this app's
-- upsertX402Network normalization) and re-runs the decimals backfill the
-- original migration silently missed for Base Sepolia.
UPDATE "X402Network"
SET "defaultAsset" = '0x036cbd53842c5426634e7929541ec2318f3dcf7e'
WHERE "caip2Id" = 'eip155:84532'
  AND LOWER("defaultAsset") = '0x036cbd53842c5426634e7929541ec2318f3dcf7c';

UPDATE "X402Network"
SET "defaultAssetDecimals" = 6
WHERE "caip2Id" = 'eip155:84532'
  AND LOWER("defaultAsset") = '0x036cbd53842c5426634e7929541ec2318f3dcf7e'
  AND "defaultAssetDecimals" IS NULL;
