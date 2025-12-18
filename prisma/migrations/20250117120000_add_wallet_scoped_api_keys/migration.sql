-- AlterEnum
ALTER TYPE "Permission" ADD VALUE 'WalletScoped';

-- CreateTable
CREATE TABLE "ApiKeyHotWallet" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "apiKeyId" TEXT NOT NULL,
    "hotWalletId" TEXT NOT NULL,

    CONSTRAINT "ApiKeyHotWallet_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ApiKeyHotWallet_apiKeyId_idx" ON "ApiKeyHotWallet"("apiKeyId");

-- CreateIndex
CREATE INDEX "ApiKeyHotWallet_hotWalletId_idx" ON "ApiKeyHotWallet"("hotWalletId");

-- CreateIndex
CREATE UNIQUE INDEX "ApiKeyHotWallet_apiKeyId_hotWalletId_key" ON "ApiKeyHotWallet"("apiKeyId", "hotWalletId");

-- AddForeignKey
ALTER TABLE "ApiKeyHotWallet" ADD CONSTRAINT "ApiKeyHotWallet_apiKeyId_fkey" FOREIGN KEY ("apiKeyId") REFERENCES "ApiKey"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApiKeyHotWallet" ADD CONSTRAINT "ApiKeyHotWallet_hotWalletId_fkey" FOREIGN KEY ("hotWalletId") REFERENCES "HotWallet"("id") ON DELETE CASCADE ON UPDATE CASCADE;

