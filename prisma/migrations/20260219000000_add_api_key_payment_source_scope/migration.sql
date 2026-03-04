-- CreateTable
CREATE TABLE "ApiKeyWalletScope" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "apiKeyId" TEXT NOT NULL,
    "hotWalletId" TEXT NOT NULL,

    CONSTRAINT "ApiKeyWalletScope_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ApiKeyWalletScope_apiKeyId_idx" ON "ApiKeyWalletScope"("apiKeyId");

-- CreateIndex
CREATE INDEX "ApiKeyWalletScope_hotWalletId_idx" ON "ApiKeyWalletScope"("hotWalletId");

-- CreateIndex
CREATE UNIQUE INDEX "ApiKeyWalletScope_apiKeyId_hotWalletId_key" ON "ApiKeyWalletScope"("apiKeyId", "hotWalletId");

-- AddForeignKey
ALTER TABLE "ApiKeyWalletScope" ADD CONSTRAINT "ApiKeyWalletScope_apiKeyId_fkey" FOREIGN KEY ("apiKeyId") REFERENCES "ApiKey"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApiKeyWalletScope" ADD CONSTRAINT "ApiKeyWalletScope_hotWalletId_fkey" FOREIGN KEY ("hotWalletId") REFERENCES "HotWallet"("id") ON DELETE CASCADE ON UPDATE CASCADE;
