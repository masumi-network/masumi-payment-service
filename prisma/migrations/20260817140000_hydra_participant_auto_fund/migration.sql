-- Whether this service keeps a Hydra node's L1 fuel topped up.
-- Existing rows were all funded by the scheduled cycle, so they keep that
-- behaviour; only invites that opt out write `false`.
ALTER TABLE "HydraLocalParticipant" ADD COLUMN "autoFund" BOOLEAN NOT NULL DEFAULT true;
