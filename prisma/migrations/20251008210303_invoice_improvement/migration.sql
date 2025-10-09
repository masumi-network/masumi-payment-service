/*
  Warnings:

  - You are about to drop the column `completeInvoiceId` on the `InvoiceRevision` table. All the data in the column will be lost.
  - A unique constraint covering the columns `[invoiceId]` on the table `InvoiceBase` will be added. If there are existing duplicate values, this will fail.
  - Added the required column `invoiceId` to the `InvoiceBase` table without a default value. This is not possible if the table is not empty.
  - Added the required column `convertedUnit` to the `InvoiceItem` table without a default value. This is not possible if the table is not empty.
  - Added the required column `decimals` to the `InvoiceItem` table without a default value. This is not possible if the table is not empty.
  - Added the required column `currencyShortId` to the `InvoiceRevision` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "InvoiceBase" ADD COLUMN     "invoiceId" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "InvoiceItem" ADD COLUMN     "convertedUnit" TEXT NOT NULL,
ADD COLUMN     "decimals" INTEGER NOT NULL;

-- AlterTable
ALTER TABLE "InvoiceRevision" DROP COLUMN "completeInvoiceId",
ADD COLUMN     "currencyShortId" TEXT NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "InvoiceBase_invoiceId_key" ON "InvoiceBase"("invoiceId");
