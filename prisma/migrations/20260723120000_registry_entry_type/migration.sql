-- CreateEnum
CREATE TYPE "RegistryEntryType" AS ENUM ('Standard', 'OpenApi', 'X402');

-- AlterTable
-- `type` gets a NOT NULL DEFAULT so every pre-existing row is backfilled to
-- Standard in place (matches "absent on-chain type resolves to Standard").
-- `apiBaseUrl` becomes nullable because OpenApi/X402 entries describe their
-- endpoints via openApiSpecUrl / x402ResourcesUrl instead; Standard entries
-- still require it, enforced at the API boundary.
ALTER TABLE "RegistryRequest"
  ADD COLUMN "type" "RegistryEntryType" NOT NULL DEFAULT 'Standard',
  ADD COLUMN "openApiSpecUrl" TEXT,
  ADD COLUMN "x402ResourcesUrl" TEXT,
  ALTER COLUMN "apiBaseUrl" DROP NOT NULL;
