-- AlterEnum
ALTER TYPE "PurchasingAction" ADD VALUE 'ExternalFundsLockingInitiated';

-- AlterTable
ALTER TABLE "PurchaseRequest" ADD COLUMN     "buyerWalletAddress" TEXT,
ADD COLUMN     "buyerWalletVkey" TEXT;
