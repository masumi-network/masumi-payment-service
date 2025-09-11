/*
  Warnings:

  - You are about to drop the column `paymentType` on the `PaymentSource` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "PaymentSource" DROP COLUMN "paymentType";

-- AlterTable
ALTER TABLE "RegistryRequest" ADD COLUMN     "paymentType" "PaymentType" NOT NULL DEFAULT 'Web3CardanoV1';
