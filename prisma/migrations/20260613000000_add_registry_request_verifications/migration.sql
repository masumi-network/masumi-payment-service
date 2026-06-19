-- CreateTable: normalized KERI/Veridian verification claims advertised by a
-- registry entry. Flat, queryable columns (no JSON blob); the nested
-- issuer/schema/credential/holder grouping is reconstructed at the API boundary
-- (see @masumi/payment-core/verification). Emitted into CIP-25 mint/update
-- metadata for trustless, issuer-agnostic third-party verification.
CREATE TABLE "AgentVerification" (
  "id" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "registryRequestId" TEXT NOT NULL,
  "method" TEXT NOT NULL,
  "schemaVersion" TEXT,
  "issuerAid" TEXT NOT NULL,
  "issuerOobi" TEXT NOT NULL,
  "schemaSaid" TEXT NOT NULL,
  "schemaOobi" TEXT NOT NULL,
  "credentialSaid" TEXT NOT NULL,
  "credentialOobi" TEXT NOT NULL,
  "credentialRegistry" TEXT,
  "holderAid" TEXT NOT NULL,
  "holderOobi" TEXT NOT NULL,
  "baseUrl" TEXT,
  CONSTRAINT "AgentVerification_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "AgentVerification_registryRequestId_idx" ON "AgentVerification"("registryRequestId");

ALTER TABLE "AgentVerification" ADD CONSTRAINT "AgentVerification_registryRequestId_fkey" FOREIGN KEY ("registryRequestId") REFERENCES "RegistryRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;
