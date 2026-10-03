-- What a withdrawal actually settled, kept apart from what it asked for.
--
-- Finalization used to overwrite "requestedLovelace" and "requestedAssets" with
-- the amounts the head reported, which destroyed the record of intent and left
-- two columns whose names no longer described their contents. The settled
-- amounts now live beside the requested ones; both are readable, and the
-- difference between them is meaningful rather than lost.
ALTER TABLE "HydraDecommit" ADD COLUMN "settledLovelace" BIGINT;
ALTER TABLE "HydraDecommit" ADD COLUMN "settledAssets" JSONB;
