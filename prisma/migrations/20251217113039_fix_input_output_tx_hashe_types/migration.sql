/*
  Warnings:

  - You are about to drop the column `inputHash` on the `PurchaseActionData` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "PaymentRequest" ALTER COLUMN "inputHash" DROP NOT NULL,
ALTER COLUMN "resultHash" DROP NOT NULL;

-- AlterTable
ALTER TABLE "PurchaseActionData" DROP COLUMN "inputHash";

-- AlterTable
ALTER TABLE "PurchaseRequest" ALTER COLUMN "resultHash" DROP NOT NULL;

-- AlterTable
ALTER TABLE "Transaction" ALTER COLUMN "txHash" DROP NOT NULL;
