-- AlterTable
ALTER TABLE "HotWallet" ADD COLUMN     "pendingFundTransferId" TEXT;

-- CreateTable
CREATE TABLE "WalletFundTransfer" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "hotWalletId" TEXT NOT NULL,
    "toAddress" TEXT NOT NULL,
    "lovelaceAmount" BIGINT NOT NULL,
    "assets" JSONB,
    "txHash" TEXT,
    "status" "TransactionStatus" NOT NULL DEFAULT 'Pending',
    "lastCheckedAt" TIMESTAMP(3),
    "errorNote" TEXT,

    CONSTRAINT "WalletFundTransfer_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "HotWallet_pendingFundTransferId_key" ON "HotWallet"("pendingFundTransferId");

-- AddForeignKey
ALTER TABLE "HotWallet" ADD CONSTRAINT "HotWallet_pendingFundTransferId_fkey" FOREIGN KEY ("pendingFundTransferId") REFERENCES "WalletFundTransfer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WalletFundTransfer" ADD CONSTRAINT "WalletFundTransfer_hotWalletId_fkey" FOREIGN KEY ("hotWalletId") REFERENCES "HotWallet"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
