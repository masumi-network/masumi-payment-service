ALTER TABLE "PaymentRequest"
ADD COLUMN "hydraFanoutHandoffHeadId" TEXT,
ADD COLUMN "hydraFanoutHandoffTxHash" TEXT,
ADD COLUMN "hydraFanoutHandoffOutputIndex" INTEGER;

ALTER TABLE "PurchaseRequest"
ADD COLUMN "hydraFanoutHandoffHeadId" TEXT,
ADD COLUMN "hydraFanoutHandoffTxHash" TEXT,
ADD COLUMN "hydraFanoutHandoffOutputIndex" INTEGER;

ALTER TABLE "PaymentRequest"
ADD CONSTRAINT "PaymentRequest_hydra_fanout_handoff_complete_check"
CHECK (
  (
    "hydraFanoutHandoffHeadId" IS NULL
    AND "hydraFanoutHandoffTxHash" IS NULL
    AND "hydraFanoutHandoffOutputIndex" IS NULL
  )
  OR (
    "hydraFanoutHandoffHeadId" IS NOT NULL
    AND "hydraFanoutHandoffTxHash" IS NOT NULL
    AND "hydraFanoutHandoffTxHash" ~ '^[0-9a-f]{64}$'
    AND "hydraFanoutHandoffOutputIndex" IS NOT NULL
    AND "hydraFanoutHandoffOutputIndex" >= 0
  )
);

ALTER TABLE "PurchaseRequest"
ADD CONSTRAINT "PurchaseRequest_hydra_fanout_handoff_complete_check"
CHECK (
  (
    "hydraFanoutHandoffHeadId" IS NULL
    AND "hydraFanoutHandoffTxHash" IS NULL
    AND "hydraFanoutHandoffOutputIndex" IS NULL
  )
  OR (
    "hydraFanoutHandoffHeadId" IS NOT NULL
    AND "hydraFanoutHandoffTxHash" IS NOT NULL
    AND "hydraFanoutHandoffTxHash" ~ '^[0-9a-f]{64}$'
    AND "hydraFanoutHandoffOutputIndex" IS NOT NULL
    AND "hydraFanoutHandoffOutputIndex" >= 0
  )
);

CREATE INDEX "PaymentRequest_hydraFanoutHandoffHeadId_idx"
ON "PaymentRequest"("hydraFanoutHandoffHeadId");

CREATE INDEX "PurchaseRequest_hydraFanoutHandoffHeadId_idx"
ON "PurchaseRequest"("hydraFanoutHandoffHeadId");
