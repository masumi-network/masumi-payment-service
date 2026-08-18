-- When the close latch was taken, written once, rather than inferred.
--
-- The stalled-close reaper aged candidates off HydraHead.updatedAt, which is
-- @updatedAt: every write to the row refreshes it, and the connection manager
-- writes one on every successful attach (it increments ownerEpoch, the
-- ownership fence). A node whose session flaps more often than the ten-minute
-- staleness window therefore kept its head's updatedAt young forever, the
-- reaper never saw it, and the latch stayed set — admitting no new L2 work on a
-- head that is still Open and whose close never reached the chain.
--
-- Backfilled from updatedAt for latches taken before this column existed: it is
-- the value the reaper was already using, so those rows keep exactly the
-- behaviour they had rather than becoming invisible to it.
ALTER TABLE "HydraHead" ADD COLUMN "closingSince" TIMESTAMP(3);

UPDATE "HydraHead" SET "closingSince" = "updatedAt" WHERE "isClosing" = true;
