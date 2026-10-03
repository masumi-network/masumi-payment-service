-- AlterEnum
ALTER TYPE "PurchaseErrorType" ADD VALUE 'PolicyDenied';

-- CreateTable
CREATE TABLE "GuardedWallet" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "hotWalletId" TEXT NOT NULL,
    "ownerAddress" TEXT NOT NULL,
    "quorumVkhs" TEXT[],
    "threshold" INTEGER NOT NULL,
    "stateTokenName" TEXT NOT NULL,
    "scriptAddress" TEXT NOT NULL,
    "policyId" TEXT NOT NULL,
    "exchainWalletId" TEXT,

    CONSTRAINT "GuardedWallet_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "GuardedWallet_hotWalletId_key" ON "GuardedWallet"("hotWalletId");

-- AddForeignKey
ALTER TABLE "GuardedWallet" ADD CONSTRAINT "GuardedWallet_hotWalletId_fkey" FOREIGN KEY ("hotWalletId") REFERENCES "HotWallet"("id") ON DELETE CASCADE ON UPDATE CASCADE;
