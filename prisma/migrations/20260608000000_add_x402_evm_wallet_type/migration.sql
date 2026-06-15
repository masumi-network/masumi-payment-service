-- Split managed EVM wallets by direction: Purchasing wallets fund outbound x402
-- payments, Selling wallets settle inbound ones (network facilitators). Mirrors the
-- Cardano HotWalletType (Selling | Purchasing) distinction.

-- CreateEnum
CREATE TYPE "X402EvmWalletType" AS ENUM ('Purchasing', 'Selling');

-- AlterTable: add as nullable first so existing rows can be backfilled before the
-- NOT NULL constraint is applied.
ALTER TABLE "X402EvmWallet" ADD COLUMN "type" "X402EvmWalletType";

-- Backfill: any wallet currently wired as a network facilitator settles inbound
-- payments, so it is a Selling wallet; every other wallet funded outbound payments
-- and becomes a Purchasing wallet.
UPDATE "X402EvmWallet"
SET "type" = 'Selling'
WHERE "id" IN (
  SELECT "facilitatorWalletId" FROM "X402Network" WHERE "facilitatorWalletId" IS NOT NULL
);

UPDATE "X402EvmWallet" SET "type" = 'Purchasing' WHERE "type" IS NULL;

-- Enforce NOT NULL now that every row carries a type.
ALTER TABLE "X402EvmWallet" ALTER COLUMN "type" SET NOT NULL;

-- CreateIndex
CREATE INDEX "X402EvmWallet_type_idx" ON "X402EvmWallet"("type");
