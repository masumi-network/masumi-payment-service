-- AlterTable
ALTER TABLE "PaymentRequest" ADD COLUMN     "layer" "TransactionLayer" NOT NULL DEFAULT 'L1';

-- AlterTable
ALTER TABLE "PurchaseRequest" ADD COLUMN     "layer" "TransactionLayer" NOT NULL DEFAULT 'L1';

-- CreateIndex
CREATE INDEX "PaymentRequest_layer_idx" ON "PaymentRequest"("layer");

-- CreateIndex
CREATE INDEX "PurchaseRequest_layer_idx" ON "PurchaseRequest"("layer");
