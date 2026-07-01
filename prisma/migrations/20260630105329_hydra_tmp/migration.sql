-- AlterTable
ALTER TABLE "_PaymentTransactionHistory" ADD CONSTRAINT "_PaymentTransactionHistory_AB_pkey" PRIMARY KEY ("A", "B");

-- DropIndex
DROP INDEX "_PaymentTransactionHistory_AB_unique";

-- AlterTable
ALTER TABLE "_PurchaseTransactionHistory" ADD CONSTRAINT "_PurchaseTransactionHistory_AB_pkey" PRIMARY KEY ("A", "B");

-- DropIndex
DROP INDEX "_PurchaseTransactionHistory_AB_unique";
