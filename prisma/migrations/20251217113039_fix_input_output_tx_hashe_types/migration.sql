-- AlterTable
ALTER TABLE "PaymentRequest" ALTER COLUMN "inputHash" DROP NOT NULL,
ALTER COLUMN "resultHash" DROP NOT NULL;

-- AlterTable
ALTER TABLE "PurchaseRequest" ALTER COLUMN "resultHash" DROP NOT NULL;

-- AlterTable
ALTER TABLE "Transaction" ALTER COLUMN "txHash" DROP NOT NULL;
