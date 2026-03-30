-- AlterTable
ALTER TABLE "PaymentRequest" ADD COLUMN     "pricingType" "PricingType" NOT NULL DEFAULT 'Fixed';

-- AlterTable
ALTER TABLE "PurchaseRequest" ADD COLUMN     "pricingType" "PricingType" NOT NULL DEFAULT 'Fixed';
