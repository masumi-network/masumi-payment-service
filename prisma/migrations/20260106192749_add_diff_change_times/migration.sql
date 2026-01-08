/*
  Warnings:

  - Made the column `inputHash` on table `PaymentRequest` required. This step will fail if there are existing NULL values in that column.

*/
-- AlterTable
ALTER TABLE "PaymentActionData" ADD COLUMN     "nextActionLastChangedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- AlterTable
ALTER TABLE "PaymentRequest" ADD COLUMN     "nextActionLastChangedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "onChainStateOrResultLastChangedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ALTER COLUMN "inputHash" SET NOT NULL;

-- AlterTable
ALTER TABLE "PurchaseActionData" ADD COLUMN     "nextActionLastChangedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- AlterTable
ALTER TABLE "PurchaseRequest" ADD COLUMN     "nextActionLastChangedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "onChainStateOrResultLastChangedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- AlterTable
ALTER TABLE "RegistryRequest" ADD COLUMN     "registrationStateLastChangedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- CreateIndex
CREATE INDEX "PaymentActionData_nextActionLastChangedAt_idx" ON "PaymentActionData"("nextActionLastChangedAt");

-- CreateIndex
CREATE INDEX "PaymentActionData_nextActionLastChangedAt_id_idx" ON "PaymentActionData"("nextActionLastChangedAt", "id");

-- CreateIndex
CREATE INDEX "PaymentRequest_nextActionLastChangedAt_idx" ON "PaymentRequest"("nextActionLastChangedAt");

-- CreateIndex
CREATE INDEX "PaymentRequest_nextActionLastChangedAt_id_idx" ON "PaymentRequest"("nextActionLastChangedAt", "id");

-- CreateIndex
CREATE INDEX "PaymentRequest_onChainStateOrResultLastChangedAt_idx" ON "PaymentRequest"("onChainStateOrResultLastChangedAt");

-- CreateIndex
CREATE INDEX "PaymentRequest_onChainStateOrResultLastChangedAt_id_idx" ON "PaymentRequest"("onChainStateOrResultLastChangedAt", "id");

-- CreateIndex
CREATE INDEX "PurchaseActionData_nextActionLastChangedAt_idx" ON "PurchaseActionData"("nextActionLastChangedAt");

-- CreateIndex
CREATE INDEX "PurchaseActionData_nextActionLastChangedAt_id_idx" ON "PurchaseActionData"("nextActionLastChangedAt", "id");

-- CreateIndex
CREATE INDEX "PurchaseRequest_nextActionLastChangedAt_idx" ON "PurchaseRequest"("nextActionLastChangedAt");

-- CreateIndex
CREATE INDEX "PurchaseRequest_nextActionLastChangedAt_id_idx" ON "PurchaseRequest"("nextActionLastChangedAt", "id");

-- CreateIndex
CREATE INDEX "PurchaseRequest_onChainStateOrResultLastChangedAt_idx" ON "PurchaseRequest"("onChainStateOrResultLastChangedAt");

-- CreateIndex
CREATE INDEX "PurchaseRequest_onChainStateOrResultLastChangedAt_id_idx" ON "PurchaseRequest"("onChainStateOrResultLastChangedAt", "id");
