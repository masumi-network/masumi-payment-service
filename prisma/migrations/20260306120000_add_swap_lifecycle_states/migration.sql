-- CreateEnum
CREATE TYPE "SwapStatus" AS ENUM ('OrderPending', 'OrderConfirmed', 'CancelPending', 'CancelConfirmed', 'Completed', 'OrderSubmitTimeout', 'CancelSubmitTimeout');

-- AlterTable
ALTER TABLE "SwapTransaction" ADD COLUMN     "swapStatus" "SwapStatus" NOT NULL DEFAULT 'OrderPending',
ADD COLUMN     "cancelTxHash" TEXT,
ADD COLUMN     "orderOutputIndex" INTEGER,
ADD COLUMN     "hotWalletId" TEXT;

-- Migrate existing data: Confirmed tx → Completed, Pending tx → OrderPending
UPDATE "SwapTransaction" SET "swapStatus" = 'Completed' WHERE "status" = 'Confirmed';
UPDATE "SwapTransaction" SET "swapStatus" = 'OrderPending' WHERE "status" = 'Pending';

-- Backfill hotWalletId from HotWallet.pendingSwapTransactionId relation
UPDATE "SwapTransaction" st
SET "hotWalletId" = hw."id"
FROM "HotWallet" hw
WHERE hw."pendingSwapTransactionId" = st."id"
AND st."hotWalletId" IS NULL;

-- AddForeignKey
ALTER TABLE "SwapTransaction" ADD CONSTRAINT "SwapTransaction_hotWalletId_fkey" FOREIGN KEY ("hotWalletId") REFERENCES "HotWallet"("id") ON DELETE SET NULL ON UPDATE CASCADE;
