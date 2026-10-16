-- Companion to 20260729100000, which repaired only X402Network."defaultAsset".
--
-- The Base Sepolia USDC typo also reached REGISTERED sources: the registration UI
-- offered ...dcf7c as its preset, and src/services/registry/source-pricing.ts writes
-- that asset into three places per source. All three must move together, so a source
-- that cannot have all three repaired is left entirely alone:
--   1. "UnitValue"."unit"                      (Fixed pricing amounts)
--   2. "SupportedPaymentSource"."dynamicAsset" (Dynamic pricing allowlist)
--   3. "SupportedPaymentSource"."canonicalKey" (duplicate-detection key; embeds the
--      lowercased asset verbatim, so a literal REPLACE reproduces exactly what
--      getSupportedPaymentSourceCanonicalKey would emit for the corrected asset)
--
-- packages/payment-source-x402/src/requirements.ts builds PaymentRequirements.asset
-- from 1 and 2, so until this runs those sources quote a contract that was never
-- deployed on Base Sepolia and no payment against them can settle.
--
-- Scope: EVM sources on eip155:84532 only. Attempt and settlement history is left as
-- written, because those rows record what actually happened. On-chain registry
-- metadata is published FROM these rows, so an already-registered agent keeps
-- advertising the old asset on chain until its operator updates the registration;
-- the update path republishes from the corrected rows.

-- Sources that are safe to repair. "SupportedPaymentSource" is unique on
-- (registryRequestId, canonicalKey), so a source whose corrected key would collide
-- with a sibling that already carries the real address is skipped rather than left
-- with pricing and canonicalKey disagreeing. Those need an operator to merge the
-- duplicate options by hand.
CREATE TEMPORARY TABLE "_repair_base_sepolia_usdc" AS
SELECT
  src."id",
  REPLACE(
    src."canonicalKey",
    '0x036cbd53842c5426634e7929541ec2318f3dcf7c',
    '0x036cbd53842c5426634e7929541ec2318f3dcf7e'
  ) AS "repairedKey"
FROM "SupportedPaymentSource" src
WHERE src."chain" = 'EVM'
  AND src."network" = 'eip155:84532'
  AND src."canonicalKey" LIKE '%0x036cbd53842c5426634e7929541ec2318f3dcf7c%'
  AND NOT EXISTS (
    SELECT 1
    FROM "SupportedPaymentSource" sibling
    WHERE sibling."registryRequestId" = src."registryRequestId"
      AND sibling."id" <> src."id"
      AND sibling."canonicalKey" = REPLACE(
        src."canonicalKey",
        '0x036cbd53842c5426634e7929541ec2318f3dcf7c',
        '0x036cbd53842c5426634e7929541ec2318f3dcf7e'
      )
  );

-- 1. Fixed pricing amounts. Reached only through this source's own pricing chain, so
-- API-key usage credits and Cardano amounts in the shared "UnitValue" table are not
-- candidates regardless of what they hold.
UPDATE "UnitValue" amount
SET "unit" = '0x036cbd53842c5426634e7929541ec2318f3dcf7e'
FROM "AgentFixedPricing" fixed
JOIN "AgentPricing" pricing ON pricing."id" = fixed."agentPricingId"
JOIN "_repair_base_sepolia_usdc" repair ON repair."id" = pricing."supportedPaymentSourceId"
WHERE amount."agentFixedPricingId" = fixed."id"
  AND amount."unit" = '0x036cbd53842c5426634e7929541ec2318f3dcf7c';

-- 2. Dynamic pricing allowlist.
UPDATE "SupportedPaymentSource" src
SET "dynamicAsset" = '0x036cbd53842c5426634e7929541ec2318f3dcf7e'
FROM "_repair_base_sepolia_usdc" repair
WHERE src."id" = repair."id"
  AND src."dynamicAsset" = '0x036cbd53842c5426634e7929541ec2318f3dcf7c';

-- 3. Duplicate-detection key, last so it stays consistent with 1 and 2.
UPDATE "SupportedPaymentSource" src
SET "canonicalKey" = repair."repairedKey"
FROM "_repair_base_sepolia_usdc" repair
WHERE src."id" = repair."id";

DROP TABLE "_repair_base_sepolia_usdc";
