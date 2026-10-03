ALTER TABLE "HydraHead"
ADD COLUMN "reconciliationCompletedAt" TIMESTAMP(3),
ADD COLUMN "isClosing" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "HydraHead"
ADD CONSTRAINT "HydraHead_reconciliation_complete_requires_final_check"
CHECK (
  "reconciliationCompletedAt" IS NULL
  OR (
    "status" = 'Final'
    AND "finalizedAt" IS NOT NULL
    AND "fanoutTxHash" IS NOT NULL
    AND "fanoutTxHash" ~ '^[0-9a-f]{64}$'
  )
);

ALTER TABLE "HydraHead"
ADD CONSTRAINT "HydraHead_fanout_tx_hash_canonical_check"
CHECK (
  "fanoutTxHash" IS NULL
  OR "fanoutTxHash" ~ '^[0-9a-f]{64}$'
);
