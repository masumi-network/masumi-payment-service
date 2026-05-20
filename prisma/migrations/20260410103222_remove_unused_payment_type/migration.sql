/*
  Warnings:

  - You are about to drop the column `paymentType` on the `RegistryRequest` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "RegistryRequest" DROP COLUMN "paymentType";

-- DropEnum
DROP TYPE "PaymentType";
