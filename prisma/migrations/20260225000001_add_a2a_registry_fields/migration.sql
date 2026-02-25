-- AlterTable: add A2A fields to RegistryRequest
ALTER TABLE "RegistryRequest" ADD COLUMN     "agentCardUrl" TEXT;
ALTER TABLE "RegistryRequest" ADD COLUMN     "a2aProtocolVersions" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "RegistryRequest" ADD COLUMN     "a2aAgentVersion" TEXT;
ALTER TABLE "RegistryRequest" ADD COLUMN     "a2aDefaultInputModes" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "RegistryRequest" ADD COLUMN     "a2aDefaultOutputModes" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "RegistryRequest" ADD COLUMN     "a2aProviderName" TEXT;
ALTER TABLE "RegistryRequest" ADD COLUMN     "a2aProviderUrl" TEXT;
ALTER TABLE "RegistryRequest" ADD COLUMN     "a2aDocumentationUrl" TEXT;
ALTER TABLE "RegistryRequest" ADD COLUMN     "a2aIconUrl" TEXT;
ALTER TABLE "RegistryRequest" ADD COLUMN     "a2aCapabilitiesStreaming" BOOLEAN;
ALTER TABLE "RegistryRequest" ADD COLUMN     "a2aCapabilitiesPushNotifications" BOOLEAN;
