/*
  Warnings:

  - You are about to drop the column `invoiceDisclaimer` on the `InvoiceRevision` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "InvoiceRevision" DROP COLUMN "invoiceDisclaimer";

-- DropEnum
DROP TYPE "SymbolPosition";
