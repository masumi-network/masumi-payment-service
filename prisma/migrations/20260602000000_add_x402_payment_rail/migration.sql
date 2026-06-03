-- Standard EVM x402 is a separate HTTP payment rail, not a Cardano escrow
-- PaymentSourceType. Keep Cardano wire APIs stable while migrating stored
-- API-key network limits to CAIP-2 chain identifiers.

CREATE TYPE "X402PaymentScheme" AS ENUM ('Exact');
CREATE TYPE "X402PaymentDirection" AS ENUM ('InboundVerify', 'InboundSettle', 'OutboundPayment');
CREATE TYPE "X402PaymentStatus" AS ENUM ('PaymentRequired', 'Verified', 'Settled', 'Failed', 'Replayed');

ALTER TABLE "ApiKey"
ADD COLUMN "networkLimitCaip2" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

UPDATE "ApiKey"
SET "networkLimitCaip2" = COALESCE(
  (
    SELECT array_agg(
      CASE network_value::TEXT
        WHEN 'Mainnet' THEN 'cardano:mainnet'
        WHEN 'Preprod' THEN 'cardano:preprod'
        ELSE network_value::TEXT
      END
      ORDER BY network_value::TEXT
    )
    FROM unnest("networkLimit") AS network_value
  ),
  ARRAY[]::TEXT[]
);

ALTER TABLE "ApiKey" DROP COLUMN "networkLimit";
ALTER TABLE "ApiKey" RENAME COLUMN "networkLimitCaip2" TO "networkLimit";
ALTER TABLE "ApiKey" ALTER COLUMN "networkLimit" DROP DEFAULT;

DROP INDEX IF EXISTS "SupportedPaymentSource_registryRequestId_chain_network_paymentSourceType_address_key";

ALTER TABLE "SupportedPaymentSource"
ALTER COLUMN "chain" TYPE TEXT USING "chain"::TEXT,
ALTER COLUMN "network" TYPE TEXT USING "network"::TEXT,
ALTER COLUMN "paymentSourceType" DROP NOT NULL,
ADD COLUMN "scheme" "X402PaymentScheme",
ADD COLUMN "asset" TEXT,
ADD COLUMN "amount" BIGINT,
ADD COLUMN "decimals" INTEGER,
ADD COLUMN "payTo" TEXT,
ADD COLUMN "resource" TEXT,
ADD COLUMN "extra" JSONB;

CREATE UNIQUE INDEX "SupportedPaymentSource_registryRequestId_chain_network_paymentSourceType_address_key"
ON "SupportedPaymentSource"("registryRequestId", "chain", "network", "paymentSourceType", "address")
WHERE "chain" = 'Cardano' AND "paymentSourceType" IS NOT NULL;

CREATE UNIQUE INDEX "SupportedPaymentSource_x402_unique_key"
ON "SupportedPaymentSource"(
  "registryRequestId",
  "chain",
  "network",
  "scheme",
  "asset",
  "amount",
  "decimals",
  "payTo",
  COALESCE("resource", '')
)
WHERE "chain" = 'EVM' AND "scheme" IS NOT NULL AND "asset" IS NOT NULL AND "payTo" IS NOT NULL;

CREATE INDEX "SupportedPaymentSource_chain_network_idx"
ON "SupportedPaymentSource"("chain", "network");

-- Completeness guarantee: every row must be either a complete Cardano escrow row
-- (paymentSourceType set) or a complete EVM x402 row (scheme/asset/amount/decimals/
-- payTo set). This makes the serializer's strict shape assertion an invariant that
-- can never fire on persisted data, and keeps Prisma's nullable columns honest.
ALTER TABLE "SupportedPaymentSource"
ADD CONSTRAINT "SupportedPaymentSource_completeness_check" CHECK (
  ("chain" = 'Cardano' AND "paymentSourceType" IS NOT NULL)
  OR (
    "chain" = 'EVM'
    AND "scheme" IS NOT NULL
    AND "asset" IS NOT NULL
    AND "amount" IS NOT NULL
    AND "decimals" IS NOT NULL
    AND "payTo" IS NOT NULL
  )
);

CREATE TABLE "X402EvmWallet" (
  "id" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "address" TEXT NOT NULL,
  "encryptedPrivateKey" TEXT NOT NULL,
  "note" TEXT,
  "deletedAt" TIMESTAMP(3),
  "createdById" TEXT,
  CONSTRAINT "X402EvmWallet_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "X402EvmWallet_address_key" ON "X402EvmWallet"("address");
CREATE INDEX "X402EvmWallet_deletedAt_idx" ON "X402EvmWallet"("deletedAt");
CREATE INDEX "X402EvmWallet_createdById_idx" ON "X402EvmWallet"("createdById");

CREATE TABLE "X402Network" (
  "id" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "caip2Id" TEXT NOT NULL,
  "displayName" TEXT NOT NULL,
  "rpcUrl" TEXT NOT NULL,
  "isTestnet" BOOLEAN NOT NULL DEFAULT false,
  "isEnabled" BOOLEAN NOT NULL DEFAULT true,
  "defaultAsset" TEXT,
  "facilitatorWalletId" TEXT,
  "createdById" TEXT,
  CONSTRAINT "X402Network_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "X402Network_caip2Id_key" ON "X402Network"("caip2Id");
CREATE INDEX "X402Network_isEnabled_idx" ON "X402Network"("isEnabled");
CREATE INDEX "X402Network_createdById_idx" ON "X402Network"("createdById");

CREATE TABLE "X402WalletBudget" (
  "id" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "apiKeyId" TEXT NOT NULL,
  "evmWalletId" TEXT NOT NULL,
  "caip2Network" TEXT NOT NULL,
  "asset" TEXT NOT NULL,
  "remainingAmount" BIGINT NOT NULL,
  "spentAmount" BIGINT NOT NULL DEFAULT 0,
  "enabled" BOOLEAN NOT NULL DEFAULT true,
  "createdById" TEXT,
  CONSTRAINT "X402WalletBudget_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "X402WalletBudget_apiKeyId_evmWalletId_caip2Network_asset_key"
ON "X402WalletBudget"("apiKeyId", "evmWalletId", "caip2Network", "asset");
CREATE INDEX "X402WalletBudget_apiKeyId_enabled_idx" ON "X402WalletBudget"("apiKeyId", "enabled");
CREATE INDEX "X402WalletBudget_evmWalletId_enabled_idx" ON "X402WalletBudget"("evmWalletId", "enabled");
CREATE INDEX "X402WalletBudget_caip2Network_asset_idx" ON "X402WalletBudget"("caip2Network", "asset");
CREATE INDEX "X402WalletBudget_createdById_idx" ON "X402WalletBudget"("createdById");

CREATE TABLE "X402PaymentAttempt" (
  "id" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "direction" "X402PaymentDirection" NOT NULL,
  "status" "X402PaymentStatus" NOT NULL,
  "apiKeyId" TEXT NOT NULL,
  "evmWalletId" TEXT,
  "registryRequestId" TEXT,
  "supportedPaymentSourceId" TEXT,
  "caip2Network" TEXT NOT NULL,
  "scheme" "X402PaymentScheme" NOT NULL DEFAULT 'Exact',
  "asset" TEXT NOT NULL,
  "amount" BIGINT NOT NULL,
  "payTo" TEXT NOT NULL,
  "payer" TEXT,
  "resource" TEXT,
  "paymentPayloadHash" TEXT,
  "paymentPayload" JSONB,
  "paymentIdentifier" TEXT,
  "errorReason" TEXT,
  "errorMessage" TEXT,
  CONSTRAINT "X402PaymentAttempt_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "X402PaymentAttempt_apiKeyId_createdAt_idx" ON "X402PaymentAttempt"("apiKeyId", "createdAt");
CREATE INDEX "X402PaymentAttempt_registryRequestId_createdAt_idx" ON "X402PaymentAttempt"("registryRequestId", "createdAt");
CREATE INDEX "X402PaymentAttempt_supportedPaymentSourceId_idx" ON "X402PaymentAttempt"("supportedPaymentSourceId");
CREATE INDEX "X402PaymentAttempt_paymentIdentifier_idx" ON "X402PaymentAttempt"("paymentIdentifier");
CREATE INDEX "X402PaymentAttempt_caip2Network_asset_idx" ON "X402PaymentAttempt"("caip2Network", "asset");
CREATE INDEX "X402PaymentAttempt_status_createdAt_idx" ON "X402PaymentAttempt"("status", "createdAt");

CREATE TABLE "X402Settlement" (
  "id" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "paymentAttemptId" TEXT NOT NULL,
  "paymentPayloadHash" TEXT NOT NULL,
  "success" BOOLEAN NOT NULL,
  "txHash" TEXT,
  "caip2Network" TEXT NOT NULL,
  "amount" BIGINT,
  "payer" TEXT,
  "rawResponse" JSONB,
  CONSTRAINT "X402Settlement_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "X402Settlement_paymentAttemptId_key" ON "X402Settlement"("paymentAttemptId");
CREATE UNIQUE INDEX "X402Settlement_paymentPayloadHash_key" ON "X402Settlement"("paymentPayloadHash");
CREATE INDEX "X402Settlement_txHash_idx" ON "X402Settlement"("txHash");
CREATE INDEX "X402Settlement_caip2Network_idx" ON "X402Settlement"("caip2Network");

ALTER TABLE "X402EvmWallet"
ADD CONSTRAINT "X402EvmWallet_createdById_fkey"
FOREIGN KEY ("createdById") REFERENCES "ApiKey"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "X402Network"
ADD CONSTRAINT "X402Network_facilitatorWalletId_fkey"
FOREIGN KEY ("facilitatorWalletId") REFERENCES "X402EvmWallet"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "X402Network"
ADD CONSTRAINT "X402Network_createdById_fkey"
FOREIGN KEY ("createdById") REFERENCES "ApiKey"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "X402WalletBudget"
ADD CONSTRAINT "X402WalletBudget_apiKeyId_fkey"
FOREIGN KEY ("apiKeyId") REFERENCES "ApiKey"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "X402WalletBudget"
ADD CONSTRAINT "X402WalletBudget_createdById_fkey"
FOREIGN KEY ("createdById") REFERENCES "ApiKey"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "X402WalletBudget"
ADD CONSTRAINT "X402WalletBudget_evmWalletId_fkey"
FOREIGN KEY ("evmWalletId") REFERENCES "X402EvmWallet"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "X402WalletBudget"
ADD CONSTRAINT "X402WalletBudget_caip2Network_fkey"
FOREIGN KEY ("caip2Network") REFERENCES "X402Network"("caip2Id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "X402PaymentAttempt"
ADD CONSTRAINT "X402PaymentAttempt_apiKeyId_fkey"
FOREIGN KEY ("apiKeyId") REFERENCES "ApiKey"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "X402PaymentAttempt"
ADD CONSTRAINT "X402PaymentAttempt_evmWalletId_fkey"
FOREIGN KEY ("evmWalletId") REFERENCES "X402EvmWallet"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "X402PaymentAttempt"
ADD CONSTRAINT "X402PaymentAttempt_registryRequestId_fkey"
FOREIGN KEY ("registryRequestId") REFERENCES "RegistryRequest"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "X402PaymentAttempt"
ADD CONSTRAINT "X402PaymentAttempt_supportedPaymentSourceId_fkey"
FOREIGN KEY ("supportedPaymentSourceId") REFERENCES "SupportedPaymentSource"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "X402PaymentAttempt"
ADD CONSTRAINT "X402PaymentAttempt_caip2Network_fkey"
FOREIGN KEY ("caip2Network") REFERENCES "X402Network"("caip2Id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "X402Settlement"
ADD CONSTRAINT "X402Settlement_paymentAttemptId_fkey"
FOREIGN KEY ("paymentAttemptId") REFERENCES "X402PaymentAttempt"("id") ON DELETE CASCADE ON UPDATE CASCADE;

INSERT INTO "X402Network" ("id", "updatedAt", "caip2Id", "displayName", "rpcUrl", "isTestnet", "isEnabled")
VALUES
  ('base-mainnet', CURRENT_TIMESTAMP, 'eip155:8453', 'Base Mainnet', 'https://mainnet.base.org', false, true),
  ('base-sepolia', CURRENT_TIMESTAMP, 'eip155:84532', 'Base Sepolia', 'https://sepolia.base.org', true, true)
ON CONFLICT ("caip2Id") DO NOTHING;
