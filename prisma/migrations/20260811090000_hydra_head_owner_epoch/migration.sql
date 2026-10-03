-- Monotonic per-head ownership fence (fencing token). Incremented once per
-- head-session acquisition; lifecycle writes carry it so a stale session's
-- late write misses its guarded UPDATE instead of clobbering a newer owner.
ALTER TABLE "HydraHead" ADD COLUMN "ownerEpoch" BIGINT NOT NULL DEFAULT 0;
