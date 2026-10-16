-- Adds the A2A (MIP-002) registry entry type. A2A registrations are V2-only
-- (enforced at the API boundary in src/routes/api/registry/index.ts, not
-- here — PostgreSQL enums are global to the database and every entry type
-- shares this one column).
--
-- A2A's two endpoint descriptors (agentCardUrl, protocolVersions) live in a
-- 1:1 detail table rather than nullable columns on RegistryRequest: every
-- other entry type would carry NULLs for descriptors it can never use, and
-- A2A is the one type whose descriptor is more than a single URL, so it is
-- the one that earns its own row.
--
-- This is NOT the per-type-table split rejected by ADR 0010: the FK is the
-- PK, so no registry field is duplicated. Name, author, legal, tags, pricing,
-- wallet and transaction lifecycle all stay on RegistryRequest, and A2A still
-- inherits the whole mint/sync/state-machine/deregister pipeline unchanged.
--
-- A detail row exists iff RegistryRequest.type = 'A2A'. That invariant lives
-- at the API boundary (getRegistryEndpointError), not in a DB CHECK, which
-- cannot span the relation — same posture as X402Network's facilitator XOR.
--
-- IF NOT EXISTS guards keep this idempotent on partial replays, matching the
-- convention used across this repo's migrations. The new enum value is
-- declared but not used by any statement in this same migration, so ADD
-- VALUE is safe inside the single transaction Prisma wraps this file in (see
-- 20260716000000_add_fund_distribution for the same reasoning).
ALTER TYPE "RegistryEntryType" ADD VALUE IF NOT EXISTS 'A2A';

-- CreateTable
CREATE TABLE IF NOT EXISTS "A2ARegistryDetail" (
    "registryRequestId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "agentCardUrl" TEXT NOT NULL,
    "protocolVersions" TEXT[],

    CONSTRAINT "A2ARegistryDetail_pkey" PRIMARY KEY ("registryRequestId")
);

-- AddForeignKey (no ADD CONSTRAINT IF NOT EXISTS in PostgreSQL, so guard on catalog)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'A2ARegistryDetail_registryRequestId_fkey'
  ) THEN
    ALTER TABLE "A2ARegistryDetail"
    ADD CONSTRAINT "A2ARegistryDetail_registryRequestId_fkey"
    FOREIGN KEY ("registryRequestId") REFERENCES "RegistryRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
