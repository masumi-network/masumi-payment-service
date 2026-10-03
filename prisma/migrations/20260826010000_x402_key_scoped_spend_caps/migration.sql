-- Replace per-wallet x402 budgets with the Cardano spend model: the key-global
-- usage-credit ledger (ApiKey.usageLimited + UnitValue rows with
-- 'eip155:<chainId>:<asset>' units) is the only spend cap, and
-- ApiKeyX402WalletScope is the only wallet-access grant. A budget row used to
-- carry BOTH meanings at once (spend cap + wallet delegation); this migration
-- keeps the delegation and deliberately DROPS the cap.
--
-- Cap semantics after this migration (deliberate operator decision): budget
-- remainders are NOT converted into usage credits and usageLimited is NOT
-- flipped. A key that was capped only by a wallet budget spends uncapped from
-- its scoped wallets afterward. Operators who want the key capped again grant
-- it eip155-format UsageCredits and set usageLimited via PATCH /api/v1/api-key.
-- The alternative (flipping usageLimited) was rejected because the flag is
-- shared with the Cardano rail and would start failing the key's Cardano
-- purchases until Cardano credits were granted.

-- 1) Preserve ACCESS. A budget on a wallet the grantee neither created nor was
--    assigned acted as an implicit delegation at pay time. Convert every
--    enabled budget into an explicit wallet-scope assignment so the grantee
--    keeps reaching the wallet. Only keys that actually run scoped
--    (x402WalletScopeEnabled) need a row: an unscoped key already reaches every
--    wallet, and writing a row for it would silently narrow-then-grant the wrong
--    access the day an admin turns scoping on. Admin keys are never scoped, and a
--    key whose scope already lists the wallet is untouched.
INSERT INTO "ApiKeyX402WalletScope" ("id", "createdAt", "apiKeyId", "evmWalletId")
SELECT
    'mig_' || md5('budget-access:' || "b"."apiKeyId" || ':' || "b"."evmWalletId"),
    CURRENT_TIMESTAMP,
    "b"."apiKeyId",
    "b"."evmWalletId"
FROM "X402WalletBudget" "b"
JOIN "ApiKey" "k" ON "k"."id" = "b"."apiKeyId"
JOIN "X402EvmWallet" "w" ON "w"."id" = "b"."evmWalletId"
WHERE "b"."enabled" = true
  AND "k"."x402WalletScopeEnabled" = true
  AND "k"."canAdmin" = false
  AND "k"."deletedAt" IS NULL
  AND "w"."deletedAt" IS NULL
ON CONFLICT ("apiKeyId", "evmWalletId") DO NOTHING;

-- 2) The budget table has no remaining meaning.
DROP TABLE "X402WalletBudget";
