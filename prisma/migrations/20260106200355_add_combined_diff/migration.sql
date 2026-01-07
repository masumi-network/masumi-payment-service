-- AlterTable
ALTER TABLE "PaymentRequest" ADD COLUMN     "nextActionOrOnChainStateOrResultLastChangedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- AlterTable
ALTER TABLE "PurchaseRequest" ADD COLUMN     "nextActionOrOnChainStateOrResultLastChangedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
