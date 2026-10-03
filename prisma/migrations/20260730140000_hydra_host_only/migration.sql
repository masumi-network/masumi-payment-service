-- Hydra: the Host-provisioned path becomes the only path.
--
-- A node is always provisioned through a Hydra Host, which generates its keys
-- and supervises its process. The hand-configured path — where an operator
-- typed node URLs and uploaded keys — is removed, so the columns that only
-- existed to support it become required or disappear.
--
-- Safe as a hard cut rather than a compatibility shim: the whole Hydra feature
-- is unreleased. None of these models exist on main or dev, so there is no
-- deployment holding rows that predate this.

-- An offer now ends by recording the head it produced.
ALTER TYPE "HydraOfferStatus" ADD VALUE 'Completed';

-- Rows from the hand-configured path, which can no longer be represented.
-- Deleting the participant cascades to nothing: HydraHead references it, so
-- remove those heads first.
DELETE FROM "HydraHead"
WHERE "id" IN (
    SELECT "hydraHeadId" FROM "HydraLocalParticipant"
    WHERE "hydraHostId" IS NULL AND "hydraHeadId" IS NOT NULL
);
DELETE FROM "HydraLocalParticipant" WHERE "hydraHostId" IS NULL OR "hostNodeId" IS NULL;

ALTER TABLE "HydraLocalParticipant" ALTER COLUMN "hydraHostId" SET NOT NULL;
ALTER TABLE "HydraLocalParticipant" ALTER COLUMN "hostNodeId" SET NOT NULL;

-- The counterparty's node API sits behind their own Host's proxy and we hold no
-- token for it, so its URLs were never usable. What we need is the peer-plane
-- address etcd dials, stored verbatim because etcd validates a member's
-- advertised URL against the cluster entry.
ALTER TABLE "HydraRemoteParticipant" ADD COLUMN "advertise" TEXT;
UPDATE "HydraRemoteParticipant"
SET "advertise" = regexp_replace("nodeHttpUrl", '^[a-z]+://', '')
WHERE "advertise" IS NULL;
ALTER TABLE "HydraRemoteParticipant" ALTER COLUMN "advertise" SET NOT NULL;
ALTER TABLE "HydraRemoteParticipant" DROP COLUMN "nodeUrl";
ALTER TABLE "HydraRemoteParticipant" DROP COLUMN "nodeHttpUrl";

-- `Started` joins the open statuses. The node is running and its peer port is
-- held, but no head record exists yet — a second offer accepted in that window
-- would provision a duplicate node for a slot already spoken for. The app-level
-- guard and this index have to agree, or the guard is only advisory.
--
-- 'Completed' is deliberately NOT referenced here: Postgres forbids using an
-- enum value added by ALTER TYPE in the same transaction that added it.
DROP INDEX "HydraHeadOffer_one_open_per_slot_key";
CREATE UNIQUE INDEX "HydraHeadOffer_one_open_per_slot_key" ON "HydraHeadOffer"("hydraRelationId", "headSequence")
    WHERE "status" IN ('Proposed', 'Accepted', 'Configured', 'Started');

-- Link an offer to the head it produced, so completion is idempotent.
ALTER TABLE "HydraHeadOffer" ADD COLUMN "hydraHeadId" TEXT;
CREATE UNIQUE INDEX "HydraHeadOffer_hydraHeadId_key" ON "HydraHeadOffer"("hydraHeadId");
ALTER TABLE "HydraHeadOffer"
    ADD CONSTRAINT "HydraHeadOffer_hydraHeadId_fkey"
    FOREIGN KEY ("hydraHeadId") REFERENCES "HydraHead"("id") ON DELETE SET NULL ON UPDATE CASCADE;
