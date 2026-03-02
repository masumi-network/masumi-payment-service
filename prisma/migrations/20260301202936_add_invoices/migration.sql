/*
  Warnings:

  - You are about to drop the column `invoiceMonth` on the `InvoiceRevision` table. All the data in the column will be lost.
  - You are about to drop the column `invoiceYear` on the `InvoiceRevision` table. All the data in the column will be lost.
  - A unique constraint covering the columns `[buyerWalletVkey,sellerWalletVkey,invoiceYear,invoiceMonth]` on the table `InvoiceBase` will be added. If there are existing duplicate values, this will fail.
  - Added the required column `buyerWalletVkey` to the `InvoiceBase` table without a default value. This is not possible if the table is not empty.
  - Added the required column `invoiceMonth` to the `InvoiceBase` table without a default value. This is not possible if the table is not empty.
  - Added the required column `invoiceYear` to the `InvoiceBase` table without a default value. This is not possible if the table is not empty.
  - Added the required column `sellerWalletVkey` to the `InvoiceBase` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "InvoiceBase" ADD COLUMN     "buyerWalletVkey" TEXT NOT NULL,
ADD COLUMN     "invoiceMonth" INTEGER NOT NULL,
ADD COLUMN     "invoiceYear" INTEGER NOT NULL,
ADD COLUMN     "sellerWalletVkey" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "InvoiceRevision" DROP COLUMN "invoiceMonth",
DROP COLUMN "invoiceYear";

-- CreateIndex
CREATE INDEX "InvoiceBase_invoiceYear_invoiceMonth_createdAt_idx" ON "InvoiceBase"("invoiceYear", "invoiceMonth", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "InvoiceBase_buyerWalletVkey_sellerWalletVkey_invoiceYear_in_key" ON "InvoiceBase"("buyerWalletVkey", "sellerWalletVkey", "invoiceYear", "invoiceMonth");
