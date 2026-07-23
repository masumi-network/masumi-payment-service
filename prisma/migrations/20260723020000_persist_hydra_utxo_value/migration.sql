ALTER TABLE "PaymentRequest"
ADD COLUMN "currentHydraUtxoValue" JSONB,
ADD COLUMN "unresolvedHydraTerminalTxHash" TEXT,
ADD COLUMN "unresolvedHydraTerminalReason" TEXT;

ALTER TABLE "PurchaseRequest"
ADD COLUMN "currentHydraUtxoValue" JSONB,
ADD COLUMN "unresolvedHydraTerminalTxHash" TEXT,
ADD COLUMN "unresolvedHydraTerminalReason" TEXT;

ALTER TABLE "PaymentRequest"
ADD CONSTRAINT "PaymentRequest_currentHydraUtxoValue_check"
CHECK (
  "currentHydraUtxoValue" IS NULL
  OR (
    "currentHydraUtxoTxHash" IS NOT NULL
    AND "currentHydraUtxoOutputIndex" IS NOT NULL
    AND jsonb_typeof("currentHydraUtxoValue") = 'array'
  )
);

ALTER TABLE "PaymentRequest"
ADD CONSTRAINT "PaymentRequest_unresolvedHydraTerminal_check"
CHECK (
  (
    "unresolvedHydraTerminalTxHash" IS NULL
    AND "unresolvedHydraTerminalReason" IS NULL
  )
  OR (
    "unresolvedHydraTerminalTxHash" IS NOT NULL
    AND "unresolvedHydraTerminalTxHash" ~ '^[0-9a-f]{64}$'
    AND "unresolvedHydraTerminalReason" IS NOT NULL
    AND "unresolvedHydraTerminalReason" = 'cip8_redeemer_not_snapshot_bound'
  )
);

ALTER TABLE "PurchaseRequest"
ADD CONSTRAINT "PurchaseRequest_currentHydraUtxoValue_check"
CHECK (
  "currentHydraUtxoValue" IS NULL
  OR (
    "currentHydraUtxoTxHash" IS NOT NULL
    AND "currentHydraUtxoOutputIndex" IS NOT NULL
    AND jsonb_typeof("currentHydraUtxoValue") = 'array'
  )
);

ALTER TABLE "PurchaseRequest"
ADD CONSTRAINT "PurchaseRequest_unresolvedHydraTerminal_check"
CHECK (
  (
    "unresolvedHydraTerminalTxHash" IS NULL
    AND "unresolvedHydraTerminalReason" IS NULL
  )
  OR (
    "unresolvedHydraTerminalTxHash" IS NOT NULL
    AND "unresolvedHydraTerminalTxHash" ~ '^[0-9a-f]{64}$'
    AND "unresolvedHydraTerminalReason" IS NOT NULL
    AND "unresolvedHydraTerminalReason" = 'cip8_redeemer_not_snapshot_bound'
  )
);

CREATE INDEX "PaymentRequest_unresolvedHydraTerminalTxHash_idx"
ON "PaymentRequest"("unresolvedHydraTerminalTxHash");

CREATE INDEX "PurchaseRequest_unresolvedHydraTerminalTxHash_idx"
ON "PurchaseRequest"("unresolvedHydraTerminalTxHash");
