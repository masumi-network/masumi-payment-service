/*
  Warnings:

  - Added the required column `isLimitedToHotWallets` to the `PurchaseRequest` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "ApiKey" ADD COLUMN     "walletScopeEnabled" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "PurchaseRequest" ADD COLUMN     "isLimitedToHotWallets" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "ApiKeyWalletScope" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "apiKeyId" TEXT NOT NULL,
    "hotWalletId" TEXT NOT NULL,

    CONSTRAINT "ApiKeyWalletScope_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_HotWalletLimit" (
    "A" TEXT NOT NULL,
    "B" TEXT NOT NULL,

    CONSTRAINT "_HotWalletLimit_AB_pkey" PRIMARY KEY ("A","B")
);

-- CreateIndex
CREATE INDEX "ApiKeyWalletScope_apiKeyId_idx" ON "ApiKeyWalletScope"("apiKeyId");

-- CreateIndex
CREATE INDEX "ApiKeyWalletScope_hotWalletId_idx" ON "ApiKeyWalletScope"("hotWalletId");

-- CreateIndex
CREATE UNIQUE INDEX "ApiKeyWalletScope_apiKeyId_hotWalletId_key" ON "ApiKeyWalletScope"("apiKeyId", "hotWalletId");

-- CreateIndex
CREATE INDEX "_HotWalletLimit_B_index" ON "_HotWalletLimit"("B");

-- AddForeignKey
ALTER TABLE "ApiKeyWalletScope" ADD CONSTRAINT "ApiKeyWalletScope_apiKeyId_fkey" FOREIGN KEY ("apiKeyId") REFERENCES "ApiKey"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApiKeyWalletScope" ADD CONSTRAINT "ApiKeyWalletScope_hotWalletId_fkey" FOREIGN KEY ("hotWalletId") REFERENCES "HotWallet"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_HotWalletLimit" ADD CONSTRAINT "_HotWalletLimit_A_fkey" FOREIGN KEY ("A") REFERENCES "HotWallet"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_HotWalletLimit" ADD CONSTRAINT "_HotWalletLimit_B_fkey" FOREIGN KEY ("B") REFERENCES "PurchaseRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;
