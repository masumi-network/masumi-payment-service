-- AlterTable
ALTER TABLE "RegistryRequest"
ADD COLUMN "recipientHotWalletId" TEXT,
ADD COLUMN "deregistrationHotWalletId" TEXT;

-- CreateIndex
CREATE INDEX "RegistryRequest_recipientHotWalletId_idx" ON "RegistryRequest"("recipientHotWalletId");

-- CreateIndex
CREATE INDEX "RegistryRequest_deregistrationHotWalletId_idx" ON "RegistryRequest"("deregistrationHotWalletId");

-- AddForeignKey
ALTER TABLE "RegistryRequest"
ADD CONSTRAINT "RegistryRequest_recipientHotWalletId_fkey"
FOREIGN KEY ("recipientHotWalletId") REFERENCES "HotWallet"("id")
ON DELETE SET NULL
ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RegistryRequest"
ADD CONSTRAINT "RegistryRequest_deregistrationHotWalletId_fkey"
FOREIGN KEY ("deregistrationHotWalletId") REFERENCES "HotWallet"("id")
ON DELETE SET NULL
ON UPDATE CASCADE;
