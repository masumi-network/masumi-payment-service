-- AlterTable
ALTER TABLE "PaymentRequest" ADD COLUMN     "totalBuyerCardanoFees" BIGINT NOT NULL DEFAULT 0,
ADD COLUMN     "totalSellerCardanoFees" BIGINT NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "PurchaseRequest" ADD COLUMN     "totalBuyerCardanoFees" BIGINT NOT NULL DEFAULT 0,
ADD COLUMN     "totalSellerCardanoFees" BIGINT NOT NULL DEFAULT 0;
