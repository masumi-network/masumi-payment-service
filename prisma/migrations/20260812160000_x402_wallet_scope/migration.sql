-- Assignable scoping for managed EVM wallets, mirroring ApiKeyWalletScope on the
-- Cardano side. Until now a non-admin key could reach exactly the wallets it had
-- created (X402EvmWallet.createdById), and there was no way for an admin to grant
-- an existing wallet to another key.

-- AlterTable
ALTER TABLE "ApiKey" ADD COLUMN "x402WalletScopeEnabled" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "ApiKeyX402WalletScope" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "apiKeyId" TEXT NOT NULL,
    "evmWalletId" TEXT NOT NULL,

    CONSTRAINT "ApiKeyX402WalletScope_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ApiKeyX402WalletScope_apiKeyId_evmWalletId_key" ON "ApiKeyX402WalletScope"("apiKeyId", "evmWalletId");

-- CreateIndex
CREATE INDEX "ApiKeyX402WalletScope_apiKeyId_idx" ON "ApiKeyX402WalletScope"("apiKeyId");

-- CreateIndex
CREATE INDEX "ApiKeyX402WalletScope_evmWalletId_idx" ON "ApiKeyX402WalletScope"("evmWalletId");

-- AddForeignKey
ALTER TABLE "ApiKeyX402WalletScope" ADD CONSTRAINT "ApiKeyX402WalletScope_apiKeyId_fkey" FOREIGN KEY ("apiKeyId") REFERENCES "ApiKey"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApiKeyX402WalletScope" ADD CONSTRAINT "ApiKeyX402WalletScope_evmWalletId_fkey" FOREIGN KEY ("evmWalletId") REFERENCES "X402EvmWallet"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Backfill so this migration changes NOTHING for any existing key.
--
-- The new flag defaults to false, which means "unrestricted" — the Cardano
-- semantic. Applied naively that would hand every existing non-admin key access to
-- every managed EVM wallet on the node, which is the opposite of what those keys
-- can do today. So: seed each non-admin key's scope with exactly the wallets it
-- created, then switch the flag on for every non-admin key.
--
-- Result: existing keys keep precisely the wallets they could already reach (a key
-- that created none still reaches none), and only keys created AFTER this migration
-- get the unrestricted default.
INSERT INTO "ApiKeyX402WalletScope" ("id", "createdAt", "apiKeyId", "evmWalletId")
SELECT
    'mig_' || md5("w"."id" || "w"."createdById"),
    CURRENT_TIMESTAMP,
    "w"."createdById",
    "w"."id"
FROM "X402EvmWallet" "w"
JOIN "ApiKey" "k" ON "k"."id" = "w"."createdById"
WHERE "w"."createdById" IS NOT NULL
  AND "k"."canAdmin" = false
ON CONFLICT ("apiKeyId", "evmWalletId") DO NOTHING;

-- Admin keys are never scoped (the auth layer short-circuits them), so this only
-- has to cover non-admins.
UPDATE "ApiKey" SET "x402WalletScopeEnabled" = true WHERE "canAdmin" = false;
