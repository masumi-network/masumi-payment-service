-- CreateEnum
CREATE TYPE "GuardedHydraTransferDirection" AS ENUM ('Deposit', 'Withdraw');

-- CreateEnum
CREATE TYPE "GuardedHydraTransferStatus" AS ENUM ('Prepared', 'Submitted', 'Confirmed', 'Expired', 'Failed');

-- CreateTable
CREATE TABLE "GuardedHydraTransfer" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "guardedWalletId" TEXT NOT NULL,
    "hydraHeadId" TEXT NOT NULL,
    "direction" "GuardedHydraTransferDirection" NOT NULL,
    "status" "GuardedHydraTransferStatus" NOT NULL,
    "txHash" TEXT NOT NULL,
    "unsignedTx" TEXT NOT NULL,
    "walletUtxoRef" TEXT NOT NULL,
    "signBefore" TIMESTAMP(3),
    "recoverableAt" TIMESTAMP(3),
    "submittedAt" TIMESTAMP(3),
    "confirmedAt" TIMESTAMP(3),
    "failureReason" TEXT,

    CONSTRAINT "GuardedHydraTransfer_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "GuardedHydraTransfer_guardedWalletId_createdAt_idx" ON "GuardedHydraTransfer"("guardedWalletId", "createdAt");

-- CreateIndex
CREATE INDEX "GuardedHydraTransfer_hydraHeadId_idx" ON "GuardedHydraTransfer"("hydraHeadId");

-- AddForeignKey
ALTER TABLE "GuardedHydraTransfer" ADD CONSTRAINT "GuardedHydraTransfer_guardedWalletId_fkey" FOREIGN KEY ("guardedWalletId") REFERENCES "GuardedWallet"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GuardedHydraTransfer" ADD CONSTRAINT "GuardedHydraTransfer_hydraHeadId_fkey" FOREIGN KEY ("hydraHeadId") REFERENCES "HydraHead"("id") ON DELETE CASCADE ON UPDATE CASCADE;
