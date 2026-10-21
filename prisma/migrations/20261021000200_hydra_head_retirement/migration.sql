-- A head that can never reach Final (an output no fanout can move) used to
-- block its relation forever, because the partial unique index below allowed
-- one non-Final head per relation. Retiring such a head records why, and what
-- was left in it, and frees the relation for a new head.
BEGIN;

ALTER TABLE "HydraHead"
  ADD COLUMN "retiredAt" TIMESTAMP(3),
  ADD COLUMN "retiredReason" TEXT,
  ADD COLUMN "retiredRemainingUtxo" JSONB,
  ADD COLUMN "retiredHeadOutputTxHash" TEXT;

-- A retired head is disabled, never Final, and carries the evidence a later
-- recovery needs: the reason and the L1 tx that holds the head output.
ALTER TABLE "HydraHead" ADD CONSTRAINT "HydraHead_retired_shape_check" CHECK (
  "retiredAt" IS NULL OR (
    "isEnabled" = false
    AND "status" <> 'Final'
    AND "retiredReason" IS NOT NULL
    -- IS NOT NULL is needed: NULL ~ pattern is NULL, which a CHECK accepts.
    AND "retiredHeadOutputTxHash" IS NOT NULL
    AND "retiredHeadOutputTxHash" ~ '^[0-9a-f]{64}$'
  )
);

DROP INDEX "HydraHead_one_non_final_per_relation_key";
CREATE UNIQUE INDEX "HydraHead_one_live_per_relation_key"
ON "HydraHead"("hydraRelationId")
WHERE "status" <> 'Final' AND "retiredAt" IS NULL;

COMMIT;
