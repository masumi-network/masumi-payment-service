/*
  Warnings:

  - You are about to drop the column `nextActionLastChangedAt` on the `PaymentActionData` table. All the data in the column will be lost.
  - You are about to drop the column `nextActionLastChangedAt` on the `PurchaseActionData` table. All the data in the column will be lost.

*/
-- DropIndex
DROP INDEX "PaymentActionData_nextActionLastChangedAt_id_idx";

-- DropIndex
DROP INDEX "PaymentActionData_nextActionLastChangedAt_idx";

-- DropIndex
DROP INDEX "PurchaseActionData_nextActionLastChangedAt_id_idx";

-- DropIndex
DROP INDEX "PurchaseActionData_nextActionLastChangedAt_idx";

-- AlterTable
ALTER TABLE "PaymentActionData" DROP COLUMN "nextActionLastChangedAt";

-- AlterTable
ALTER TABLE "PurchaseActionData" DROP COLUMN "nextActionLastChangedAt";
