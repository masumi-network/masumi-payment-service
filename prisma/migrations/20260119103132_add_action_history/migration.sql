/*
  Warnings:

  - The `events` column on the `WebhookEndpoint` table would be dropped and recreated. This will lead to data loss if there is data in the column.
  - Changed the type of `eventType` on the `WebhookDelivery` table. No cast exists, the column would be dropped and recreated, which cannot be done if there is data, since the column is required.

*/
-- CreateEnum
CREATE TYPE "WebhookEventType" AS ENUM ('PURCHASE_ON_CHAIN_STATUS_CHANGED', 'PAYMENT_ON_CHAIN_STATUS_CHANGED', 'PURCHASE_ON_ERROR', 'PAYMENT_ON_ERROR');

-- AlterTable
ALTER TABLE "PaymentActionData" ADD COLUMN     "paymentRequestHistoryId" TEXT;

-- AlterTable
ALTER TABLE "PurchaseActionData" ADD COLUMN     "purchaseRequestHistoryId" TEXT;

-- AlterTable
ALTER TABLE "WebhookDelivery" DROP COLUMN "eventType",
ADD COLUMN     "eventType" "WebhookEventType" NOT NULL;

-- AlterTable
ALTER TABLE "WebhookEndpoint" ADD COLUMN     "createdByApiKeyId" TEXT,
DROP COLUMN "events",
ADD COLUMN     "events" "WebhookEventType"[];

-- AddForeignKey
ALTER TABLE "PaymentActionData" ADD CONSTRAINT "PaymentActionData_paymentRequestHistoryId_fkey" FOREIGN KEY ("paymentRequestHistoryId") REFERENCES "PaymentRequest"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurchaseActionData" ADD CONSTRAINT "PurchaseActionData_purchaseRequestHistoryId_fkey" FOREIGN KEY ("purchaseRequestHistoryId") REFERENCES "PurchaseRequest"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WebhookEndpoint" ADD CONSTRAINT "WebhookEndpoint_createdByApiKeyId_fkey" FOREIGN KEY ("createdByApiKeyId") REFERENCES "ApiKey"("id") ON DELETE SET NULL ON UPDATE CASCADE;
