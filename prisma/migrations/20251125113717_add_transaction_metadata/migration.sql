-- AlterTable
ALTER TABLE "Transaction" ADD COLUMN     "fees" TEXT,
ADD COLUMN     "deposit" TEXT,
ADD COLUMN     "size" INTEGER,
ADD COLUMN     "block" TEXT,
ADD COLUMN     "blockHeight" INTEGER,
ADD COLUMN     "blockTime" INTEGER,
ADD COLUMN     "slot" BIGINT,
ADD COLUMN     "txIndex" INTEGER,
ADD COLUMN     "invalidBefore" BIGINT,
ADD COLUMN     "invalidHereafter" BIGINT;


