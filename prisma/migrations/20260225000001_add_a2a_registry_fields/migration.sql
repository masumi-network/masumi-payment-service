-- Drop A2A sparse columns from RegistryRequest (added in earlier iteration of this migration)
ALTER TABLE "RegistryRequest" DROP COLUMN IF EXISTS "agentCardUrl";
ALTER TABLE "RegistryRequest" DROP COLUMN IF EXISTS "a2aProtocolVersions";
ALTER TABLE "RegistryRequest" DROP COLUMN IF EXISTS "a2aAgentVersion";
ALTER TABLE "RegistryRequest" DROP COLUMN IF EXISTS "a2aDefaultInputModes";
ALTER TABLE "RegistryRequest" DROP COLUMN IF EXISTS "a2aDefaultOutputModes";
ALTER TABLE "RegistryRequest" DROP COLUMN IF EXISTS "a2aProviderName";
ALTER TABLE "RegistryRequest" DROP COLUMN IF EXISTS "a2aProviderUrl";
ALTER TABLE "RegistryRequest" DROP COLUMN IF EXISTS "a2aDocumentationUrl";
ALTER TABLE "RegistryRequest" DROP COLUMN IF EXISTS "a2aIconUrl";
ALTER TABLE "RegistryRequest" DROP COLUMN IF EXISTS "a2aCapabilitiesStreaming";
ALTER TABLE "RegistryRequest" DROP COLUMN IF EXISTS "a2aCapabilitiesPushNotifications";

-- Drop metadataVersion from RegistryRequest (now implicit: always 1 for standard agents)
ALTER TABLE "RegistryRequest" DROP COLUMN IF EXISTS "metadataVersion";

-- CreateTable: A2ARegistryRequest
CREATE TABLE "A2ARegistryRequest" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "lastCheckedAt" TIMESTAMP(3),
    "paymentSourceId" TEXT NOT NULL,
    "smartContractWalletId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "apiBaseUrl" TEXT NOT NULL,
    "agentCardUrl" TEXT NOT NULL,
    "a2aProtocolVersions" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "tags" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "agentPricingId" TEXT NOT NULL,
    "a2aAgentVersion" TEXT,
    "a2aDefaultInputModes" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "a2aDefaultOutputModes" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "a2aProviderName" TEXT,
    "a2aProviderUrl" TEXT,
    "a2aDocumentationUrl" TEXT,
    "a2aIconUrl" TEXT,
    "a2aCapabilitiesStreaming" BOOLEAN,
    "a2aCapabilitiesPushNotifications" BOOLEAN,
    "agentIdentifier" TEXT,
    "state" "RegistrationState" NOT NULL,
    "registrationStateLastChangedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "currentTransactionId" TEXT,
    "error" TEXT,
    "paymentType" "PaymentType" NOT NULL DEFAULT 'Web3CardanoV1',

    CONSTRAINT "A2ARegistryRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "A2ARegistryRequest_agentPricingId_key" ON "A2ARegistryRequest"("agentPricingId");
CREATE UNIQUE INDEX "A2ARegistryRequest_agentIdentifier_key" ON "A2ARegistryRequest"("agentIdentifier");

-- AddForeignKey
ALTER TABLE "A2ARegistryRequest" ADD CONSTRAINT "A2ARegistryRequest_paymentSourceId_fkey"
    FOREIGN KEY ("paymentSourceId") REFERENCES "PaymentSource"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "A2ARegistryRequest" ADD CONSTRAINT "A2ARegistryRequest_smartContractWalletId_fkey"
    FOREIGN KEY ("smartContractWalletId") REFERENCES "HotWallet"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "A2ARegistryRequest" ADD CONSTRAINT "A2ARegistryRequest_agentPricingId_fkey"
    FOREIGN KEY ("agentPricingId") REFERENCES "AgentPricing"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "A2ARegistryRequest" ADD CONSTRAINT "A2ARegistryRequest_currentTransactionId_fkey"
    FOREIGN KEY ("currentTransactionId") REFERENCES "Transaction"("id") ON DELETE SET NULL ON UPDATE CASCADE;
