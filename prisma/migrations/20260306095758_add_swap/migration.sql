/*
  Warnings:

  - A unique constraint covering the columns `[pendingSwapTransactionId]` on the table `HotWallet` will be added. If there are existing duplicate values, this will fail.

*/
-- AlterTable
ALTER TABLE "HotWallet" ADD COLUMN     "pendingSwapTransactionId" TEXT;

-- CreateTable
CREATE TABLE "SwapTransaction" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "txHash" TEXT,
    "status" "TransactionStatus" NOT NULL,
    "confirmations" INTEGER,
    "lastCheckedAt" TIMESTAMP(3),
    "fromPolicyId" TEXT NOT NULL,
    "fromAssetName" TEXT NOT NULL,
    "fromAmount" TEXT NOT NULL,
    "toPolicyId" TEXT NOT NULL,
    "toAssetName" TEXT NOT NULL,
    "poolId" TEXT NOT NULL,
    "slippage" DOUBLE PRECISION,

    CONSTRAINT "SwapTransaction_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "HotWallet_pendingSwapTransactionId_key" ON "HotWallet"("pendingSwapTransactionId");

-- AddForeignKey
ALTER TABLE "HotWallet" ADD CONSTRAINT "HotWallet_pendingSwapTransactionId_fkey" FOREIGN KEY ("pendingSwapTransactionId") REFERENCES "SwapTransaction"("id") ON DELETE SET NULL ON UPDATE CASCADE;
