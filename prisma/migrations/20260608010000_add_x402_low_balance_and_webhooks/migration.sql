-- CreateTable: per-wallet low-balance rules for managed EVM wallets. Mirrors
-- HotWalletLowBalanceRule but keyed by (caip2Network, asset) since EVM balances are
-- per-chain and per-token; asset is an ERC-20 contract or the literal "native".
CREATE TABLE "X402EvmWalletLowBalanceRule" (
  "id" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "evmWalletId" TEXT NOT NULL,
  "caip2Network" TEXT NOT NULL,
  "asset" TEXT NOT NULL,
  "thresholdAmount" BIGINT NOT NULL,
  "enabled" BOOLEAN NOT NULL DEFAULT true,
  "status" "LowBalanceStatus" NOT NULL DEFAULT 'Unknown',
  "lastKnownAmount" BIGINT,
  "lastCheckedAt" TIMESTAMP(3),
  "lastAlertedAt" TIMESTAMP(3),
  CONSTRAINT "X402EvmWalletLowBalanceRule_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "X402EvmWalletLowBalanceRule_evmWalletId_caip2Network_asset_key"
  ON "X402EvmWalletLowBalanceRule"("evmWalletId", "caip2Network", "asset");
CREATE INDEX "X402EvmWalletLowBalanceRule_evmWalletId_enabled_idx"
  ON "X402EvmWalletLowBalanceRule"("evmWalletId", "enabled");
CREATE INDEX "X402EvmWalletLowBalanceRule_enabled_status_idx"
  ON "X402EvmWalletLowBalanceRule"("enabled", "status");

ALTER TABLE "X402EvmWalletLowBalanceRule"
  ADD CONSTRAINT "X402EvmWalletLowBalanceRule_evmWalletId_fkey"
  FOREIGN KEY ("evmWalletId") REFERENCES "X402EvmWallet"("id") ON DELETE CASCADE ON UPDATE CASCADE;
