ALTER TABLE "HydraLocalParticipant"
ADD COLUMN "commitInvalidHereafterSlot" BIGINT;

-- Existing hashes were written only after the old implementation trusted a
-- successful submit response. Their signed TTL was not retained; canonicalize
-- the hash and use a non-pending legacy marker so the pair invariant can hold.
UPDATE "HydraLocalParticipant"
SET
  "commitTxHash" = lower("commitTxHash"),
  "commitInvalidHereafterSlot" = 0
WHERE "commitTxHash" IS NOT NULL;

ALTER TABLE "HydraLocalParticipant"
ADD CONSTRAINT "HydraLocalParticipant_commitInvalidHereafterSlot_check"
CHECK (
  (
    "commitTxHash" IS NULL
    AND "commitInvalidHereafterSlot" IS NULL
  )
  OR (
    "commitTxHash" IS NOT NULL
    AND "commitTxHash" ~ '^[0-9a-f]{64}$'
    AND "commitInvalidHereafterSlot" IS NOT NULL
    AND "commitInvalidHereafterSlot" >= 0
  )
);

CREATE INDEX "HydraLocalParticipant_hasCommitted_updatedAt_idx"
ON "HydraLocalParticipant"("hasCommitted", "updatedAt");
