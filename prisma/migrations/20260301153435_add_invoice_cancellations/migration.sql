/*
  Warnings:

  - You are about to drop the column `invoiceType` on the `InvoiceBase` table. All the data in the column will be lost.
  - You are about to drop the column `correctionInvoiceDescription` on the `InvoiceRevision` table. All the data in the column will be lost.
  - You are about to drop the column `correctionInvoiceOriginalDate` on the `InvoiceRevision` table. All the data in the column will be lost.
  - You are about to drop the column `correctionInvoiceOriginalNumber` on the `InvoiceRevision` table. All the data in the column will be lost.
  - You are about to drop the column `correctionInvoiceReason` on the `InvoiceRevision` table. All the data in the column will be lost.
  - You are about to drop the column `correctionInvoiceTitle` on the `InvoiceRevision` table. All the data in the column will be lost.
  - A unique constraint covering the columns `[cancellationId]` on the table `InvoiceRevision` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[invoiceBaseId]` on the table `PaymentRequest` will be added. If there are existing duplicate values, this will fail.
  - Added the required column `generatedInvoiceUpdatedAt` to the `InvoiceRevision` table without a default value. This is not possible if the table is not empty.
  - Added the required column `invoiceMonth` to the `InvoiceRevision` table without a default value. This is not possible if the table is not empty.
  - Added the required column `invoiceYear` to the `InvoiceRevision` table without a default value. This is not possible if the table is not empty.
  - Added the required column `reverseCharge` to the `InvoiceRevision` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "InvoiceBase" DROP COLUMN "invoiceType";

-- AlterTable
ALTER TABLE "InvoiceRevision" DROP COLUMN "correctionInvoiceDescription",
DROP COLUMN "correctionInvoiceOriginalDate",
DROP COLUMN "correctionInvoiceOriginalNumber",
DROP COLUMN "correctionInvoiceReason",
DROP COLUMN "correctionInvoiceTitle",
ADD COLUMN     "buyerWalletAddress" TEXT,
ADD COLUMN     "cancellationDate" TIMESTAMP(3),
ADD COLUMN     "cancellationId" TEXT,
ADD COLUMN     "cancellationReason" TEXT,
ADD COLUMN     "generatedCancelledInvoice" BYTEA,
ADD COLUMN     "generatedCancelledInvoiceUpdatedAt" TIMESTAMP(3),
ADD COLUMN     "generatedInvoiceUpdatedAt" TIMESTAMP(3) NOT NULL,
ADD COLUMN     "invoiceMonth" INTEGER NOT NULL,
ADD COLUMN     "invoiceYear" INTEGER NOT NULL,
ADD COLUMN     "isCancelled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "reverseCharge" BOOLEAN NOT NULL,
ADD COLUMN     "sellerWalletAddress" TEXT;

-- AlterTable
ALTER TABLE "PaymentRequest" ADD COLUMN     "invoiceBaseId" TEXT;

-- DropEnum
DROP TYPE "InvoiceType";

-- CreateIndex
CREATE UNIQUE INDEX "InvoiceRevision_cancellationId_key" ON "InvoiceRevision"("cancellationId");

-- CreateIndex
CREATE UNIQUE INDEX "PaymentRequest_invoiceBaseId_key" ON "PaymentRequest"("invoiceBaseId");

-- AddForeignKey
ALTER TABLE "PaymentRequest" ADD CONSTRAINT "PaymentRequest_invoiceBaseId_fkey" FOREIGN KEY ("invoiceBaseId") REFERENCES "InvoiceBase"("id") ON DELETE SET NULL ON UPDATE CASCADE;
