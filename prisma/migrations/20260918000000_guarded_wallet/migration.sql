-- AlterTable
ALTER TABLE "PurchaseRequest" ADD COLUMN "cosignDenied" JSONB;

-- CreateTable
CREATE TABLE "GuardedWallet" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "hotWalletId" TEXT NOT NULL,
    "walletAddress" TEXT NOT NULL,
    "stateToken" TEXT NOT NULL,
    "scriptHash" TEXT NOT NULL,
    "ownerKeyHash" TEXT NOT NULL,
    "quorumKeyHashes" TEXT[],
    "quorumThreshold" INTEGER NOT NULL,
    "cosignBaseUrl" TEXT NOT NULL,
    "cosignTokenRef" TEXT NOT NULL,
    "exchainWalletId" TEXT NOT NULL,
    "nodeId" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "registeredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GuardedWallet_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "GuardedWallet_hotWalletId_key" ON "GuardedWallet"("hotWalletId");

-- AddForeignKey
ALTER TABLE "GuardedWallet" ADD CONSTRAINT "GuardedWallet_hotWalletId_fkey" FOREIGN KEY ("hotWalletId") REFERENCES "HotWallet"("id") ON DELETE CASCADE ON UPDATE CASCADE;
