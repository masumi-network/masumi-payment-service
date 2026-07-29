-- CreateEnum
CREATE TYPE "HydraHostStatus" AS ENUM ('Active', 'Draining', 'Unreachable', 'Disabled');

-- CreateTable
CREATE TABLE "HydraHost" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "name" TEXT NOT NULL,
    "network" "Network" NOT NULL,
    "baseUrl" TEXT NOT NULL,
    "publicPeerHost" TEXT NOT NULL,
    "encryptedAdminToken" TEXT,
    "encryptedUserToken" TEXT NOT NULL,
    "hydraVersion" TEXT,
    "scriptCatalogueHash" TEXT,
    "ledgerParamsHash" TEXT,
    "status" "HydraHostStatus" NOT NULL DEFAULT 'Active',
    "lastHealthAt" TIMESTAMP(3),
    "lastHealthError" TEXT,

    CONSTRAINT "HydraHost_pkey" PRIMARY KEY ("id")
);

-- One registration per control-plane URL per network. Registering the same Host
-- twice would let two rows hand out placements against a single pool of node
-- slots, so capacity accounting would silently double-count.
CREATE UNIQUE INDEX "HydraHost_network_baseUrl_key" ON "HydraHost"("network", "baseUrl");

-- CreateIndex
CREATE INDEX "HydraHost_network_status_idx" ON "HydraHost"("network", "status");

-- AlterTable: place a local participant's node on a Host.
ALTER TABLE "HydraLocalParticipant" ADD COLUMN "hydraHostId" TEXT;
ALTER TABLE "HydraLocalParticipant" ADD COLUMN "hostNodeId" TEXT;

-- A supervised node belongs to exactly one participant. Two participants
-- pointing at the same node would drive one head's state from two rows.
-- Postgres treats NULLs as distinct, so hand-configured participants (both
-- columns NULL, the legacy env-seeded path) are unaffected by this index.
CREATE UNIQUE INDEX "HydraLocalParticipant_hydraHostId_hostNodeId_key" ON "HydraLocalParticipant"("hydraHostId", "hostNodeId");

-- Restrict rather than Cascade: deleting a Host that still has participants
-- would orphan live heads whose persistence directory lives on that machine,
-- and that directory is the only copy of their head state. Drain first.
ALTER TABLE "HydraLocalParticipant" ADD CONSTRAINT "HydraLocalParticipant_hydraHostId_fkey" FOREIGN KEY ("hydraHostId") REFERENCES "HydraHost"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
