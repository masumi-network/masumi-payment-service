/*
  Warnings:

  - You are about to drop the `CollateralRequest` table. If the table is not empty, all the data it contains will be lost.

*/
-- DropForeignKey
ALTER TABLE "CollateralRequest" DROP CONSTRAINT "CollateralRequest_hotWalletId_fkey";

-- DropForeignKey
ALTER TABLE "CollateralRequest" DROP CONSTRAINT "CollateralRequest_paymentSourceId_fkey";

-- DropForeignKey
ALTER TABLE "CollateralRequest" DROP CONSTRAINT "CollateralRequest_transactionId_fkey";

-- DropTable
DROP TABLE "CollateralRequest";

-- DropEnum
DROP TYPE "CollateralRequestState";
