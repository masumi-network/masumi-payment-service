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
    "transactionId" TEXT,

    CONSTRAINT "WalletFundTransfer_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "WalletFundTransfer_transactionId_key" ON "WalletFundTransfer"("transactionId");

-- CreateIndex
CREATE INDEX "WalletFundTransfer_hotWalletId_idx" ON "WalletFundTransfer"("hotWalletId");

-- CreateIndex
CREATE INDEX "WalletFundTransfer_status_txHash_idx" ON "WalletFundTransfer"("status", "txHash");

-- AddForeignKey
ALTER TABLE "WalletFundTransfer" ADD CONSTRAINT "WalletFundTransfer_transactionId_fkey" FOREIGN KEY ("transactionId") REFERENCES "Transaction"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WalletFundTransfer" ADD CONSTRAINT "WalletFundTransfer_hotWalletId_fkey" FOREIGN KEY ("hotWalletId") REFERENCES "HotWallet"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
