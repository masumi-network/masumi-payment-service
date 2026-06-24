/*
  Warnings:

  - You are about to drop the column `paymentType` on the `RegistryRequest` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "RegistryRequest" DROP COLUMN "paymentType";

-- AlterTable
ALTER TABLE "A2ARegistryRequest" DROP COLUMN IF EXISTS "paymentType";

-- DropEnum
DROP TYPE "PaymentType";
