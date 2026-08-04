-- CreateEnum
CREATE TYPE "TxSyncQuarantineReason" AS ENUM ('ExtendedLookupFailed', 'ProcessingFailed');

-- CreateTable
CREATE TABLE "TxSyncQuarantine" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "paymentSourceId" TEXT NOT NULL,
    "txHash" TEXT NOT NULL,
    "blockHeight" INTEGER,
    "txIndex" INTEGER,
    "reason" "TxSyncQuarantineReason" NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "nextRetryAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),
    "needsOperator" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "TxSyncQuarantine_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "TxSyncQuarantine_paymentSourceId_txHash_key" ON "TxSyncQuarantine"("paymentSourceId", "txHash");

-- CreateIndex
CREATE INDEX "TxSyncQuarantine_resolvedAt_nextRetryAt_idx" ON "TxSyncQuarantine"("resolvedAt", "nextRetryAt");

-- CreateIndex
CREATE INDEX "TxSyncQuarantine_needsOperator_idx" ON "TxSyncQuarantine"("needsOperator");

-- AddForeignKey
ALTER TABLE "TxSyncQuarantine" ADD CONSTRAINT "TxSyncQuarantine_paymentSourceId_fkey" FOREIGN KEY ("paymentSourceId") REFERENCES "PaymentSource"("id") ON DELETE CASCADE ON UPDATE CASCADE;
