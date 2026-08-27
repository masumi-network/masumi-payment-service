-- Optional per-request layer overrides for L1 vs Hydra (L2) routing.
-- PurchaseRequest.forceLayer is the buyer override; paymentForceLayer is the
-- seller choice authenticated by the V2 payment signature. Null = auto.
ALTER TABLE "PurchaseRequest" ADD COLUMN "forceLayer" "TransactionLayer";
ALTER TABLE "PurchaseRequest" ADD COLUMN "paymentForceLayer" "TransactionLayer";
ALTER TABLE "PaymentRequest" ADD COLUMN "forceLayer" "TransactionLayer";

-- Exact pre-submit context for Hydra reservations. The signed body TTL itself
-- reuses Transaction.invalidHereafterSlot. Replay absence after expiry is not
-- negative proof of rejection, so automated recovery keeps the reservation
-- fail-closed; these fields support definitive pre-acceptance rollback and a
-- future explicit protocol that resolves competing outcomes atomically.
ALTER TABLE "Transaction" ADD COLUMN "l2ReservationPreviousActionId" TEXT;
ALTER TABLE "Transaction" ADD COLUMN "l2ReservationPreviousTransactionId" TEXT;
ALTER TABLE "Transaction" ADD COLUMN "l2ReservationPreviousLayer" "TransactionLayer";
ALTER TABLE "Transaction" ADD COLUMN "l2ReservationPeerPreviousLayer" "TransactionLayer";
ALTER TABLE "Transaction" ADD COLUMN "l2ReservationPreviousSmartContractWalletId" TEXT;
ALTER TABLE "Transaction" ADD COLUMN "l2ReservationPreviousBuyerReturnAddress" TEXT;
ALTER TABLE "Transaction" ADD COLUMN "l2ReservationPreviousCollateralReturn" BIGINT;

ALTER TABLE "HydraHead" ADD COLUMN "lastReconciledSnapshotSequence" BIGINT;
ALTER TABLE "HydraHead" ADD COLUMN "lastReconciledSnapshotTransactionIndex" INTEGER;
ALTER TABLE "HydraHead" ADD CONSTRAINT "HydraHead_reconciled_cursor_pair_check"
CHECK (
  ("lastReconciledSnapshotSequence" IS NULL AND "lastReconciledSnapshotTransactionIndex" IS NULL)
  OR
  (
    "lastReconciledSnapshotSequence" IS NOT NULL
    AND "lastReconciledSnapshotSequence" >= 0
    AND "lastReconciledSnapshotTransactionIndex" IS NOT NULL
    AND "lastReconciledSnapshotTransactionIndex" >= 0
  )
);

-- Durable exact lineage for live in-head escrow outputs. A pending L2 action
-- replaces CurrentTransaction before spending the prior output, so both parts
-- of the prior output reference must remain on the request itself.
ALTER TABLE "PaymentRequest" ADD COLUMN "currentHydraUtxoTxHash" TEXT;
ALTER TABLE "PaymentRequest" ADD COLUMN "currentHydraUtxoOutputIndex" INTEGER;
ALTER TABLE "PurchaseRequest" ADD COLUMN "currentHydraUtxoTxHash" TEXT;
ALTER TABLE "PurchaseRequest" ADD COLUMN "currentHydraUtxoOutputIndex" INTEGER;

ALTER TABLE "PaymentRequest" ADD CONSTRAINT "PaymentRequest_hydra_utxo_pair_check"
CHECK (
  ("currentHydraUtxoTxHash" IS NULL AND "currentHydraUtxoOutputIndex" IS NULL)
  OR
  (
    "currentHydraUtxoTxHash" IS NOT NULL
    AND "currentHydraUtxoTxHash" ~ '^[0-9a-f]{64}$'
    AND "currentHydraUtxoOutputIndex" IS NOT NULL
    AND "currentHydraUtxoOutputIndex" BETWEEN 0 AND 2147483647
  )
);
ALTER TABLE "PurchaseRequest" ADD CONSTRAINT "PurchaseRequest_hydra_utxo_pair_check"
CHECK (
  ("currentHydraUtxoTxHash" IS NULL AND "currentHydraUtxoOutputIndex" IS NULL)
  OR
  (
    "currentHydraUtxoTxHash" IS NOT NULL
    AND "currentHydraUtxoTxHash" ~ '^[0-9a-f]{64}$'
    AND "currentHydraUtxoOutputIndex" IS NOT NULL
    AND "currentHydraUtxoOutputIndex" BETWEEN 0 AND 2147483647
  )
);

CREATE INDEX "PaymentRequest_currentHydraUtxoTxHash_idx" ON "PaymentRequest"("currentHydraUtxoTxHash");
CREATE INDEX "PurchaseRequest_currentHydraUtxoTxHash_idx" ON "PurchaseRequest"("currentHydraUtxoTxHash");
