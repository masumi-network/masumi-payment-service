-- CreateEnum
CREATE TYPE "HydraOfferRole" AS ENUM ('Offerer', 'Acceptor');

-- CreateEnum
CREATE TYPE "HydraOfferStatus" AS ENUM ('Proposed', 'Accepted', 'Configured', 'Started', 'Declined', 'Expired');

-- AlterTable: where this relation's head offers are delivered.
ALTER TABLE "HydraRelation" ADD COLUMN "counterpartyBaseUrl" TEXT;

-- CreateTable
CREATE TABLE "HydraHeadOffer" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "hydraRelationId" TEXT NOT NULL,
    "headSequence" INTEGER NOT NULL,
    "nonce" TEXT NOT NULL,
    "role" "HydraOfferRole" NOT NULL,
    "status" "HydraOfferStatus" NOT NULL DEFAULT 'Proposed',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "ownNodeId" TEXT,
    "offeredHydraVerificationKey" TEXT NOT NULL,
    "offeredCardanoVerificationKey" TEXT NOT NULL,
    "offeredAdvertise" TEXT NOT NULL,
    "counterpartyHydraVerificationKey" TEXT,
    "counterpartyCardanoVerificationKey" TEXT,
    "counterpartyAdvertise" TEXT,
    "contestationPeriodSeconds" INTEGER NOT NULL,
    "depositPeriodSeconds" INTEGER NOT NULL,
    "unsyncedPeriodSeconds" INTEGER NOT NULL,
    "ledgerParamsHash" TEXT,
    "counterpartySignature" TEXT,
    "counterpartySignerKey" TEXT,

    CONSTRAINT "HydraHeadOffer_pkey" PRIMARY KEY ("id")
);

-- The nonce is covered by the signature and is what makes an offer single-use,
-- so it must be globally unique: reusing one would let an old, already-signed
-- offer be replayed to open a head nobody asked for.
CREATE UNIQUE INDEX "HydraHeadOffer_nonce_key" ON "HydraHeadOffer"("nonce");

-- CreateIndex
CREATE INDEX "HydraHeadOffer_hydraRelationId_headSequence_idx" ON "HydraHeadOffer"("hydraRelationId", "headSequence");

-- CreateIndex
CREATE INDEX "HydraHeadOffer_status_expiresAt_idx" ON "HydraHeadOffer"("status", "expiresAt");

-- At most one OPEN offer per head slot, as a partial unique index (not
-- expressible in schema.prisma), mirroring HydraHead's one-non-final-per-relation
-- index. Two concurrent offers would each provision a node and reserve a peer
-- port while only one could ever become the head, so a second offer fails closed
-- with a unique violation while the first is still in flight.
CREATE UNIQUE INDEX "HydraHeadOffer_one_open_per_slot_key" ON "HydraHeadOffer"("hydraRelationId", "headSequence")
    WHERE "status" IN ('Proposed', 'Accepted', 'Configured');

-- AddForeignKey
ALTER TABLE "HydraHeadOffer" ADD CONSTRAINT "HydraHeadOffer_hydraRelationId_fkey" FOREIGN KEY ("hydraRelationId") REFERENCES "HydraRelation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
