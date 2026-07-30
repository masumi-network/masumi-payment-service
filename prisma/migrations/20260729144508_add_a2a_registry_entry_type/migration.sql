-- Adds the A2A (MIP-002) registry entry type. A2A registrations are V2-only
-- (enforced at the API boundary in src/routes/api/registry/index.ts, not
-- here — PostgreSQL enums are global to the database and every entry type
-- shares this one column). Unlike OpenApi/X402 (single alternate endpoint
-- field), A2A requires BOTH apiBaseUrl and a2aAgentCardUrl per MIP-002's
-- on-chain schema (api_url + agent_card_url are both Required); enforced by
-- getRegistryEndpointError, not a DB constraint.
--
-- IF NOT EXISTS / IF EXISTS guards keep this idempotent on partial replays,
-- matching the convention used across this repo's migrations. The new enum
-- value is declared but not used by any statement in this same migration,
-- so ADD VALUE is safe inside the single transaction Prisma wraps this file
-- in (see 20260716000000_add_fund_distribution for the same reasoning).
ALTER TYPE "RegistryEntryType" ADD VALUE IF NOT EXISTS 'A2A';

-- AlterTable
ALTER TABLE "RegistryRequest"
ADD COLUMN IF NOT EXISTS "a2aAgentCardUrl" TEXT,
ADD COLUMN IF NOT EXISTS "a2aProtocolVersions" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
