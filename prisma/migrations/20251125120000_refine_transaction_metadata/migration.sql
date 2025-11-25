-- AlterTable: Remove unnecessary fields and add new useful metadata fields
ALTER TABLE "Transaction" DROP COLUMN "deposit",
DROP COLUMN "size",
DROP COLUMN "block",
DROP COLUMN "slot",
DROP COLUMN "txIndex",
DROP COLUMN "invalidBefore",
DROP COLUMN "invalidHereafter",
ADD COLUMN     "outputAmount" TEXT,
ADD COLUMN     "utxoCount" INTEGER,
ADD COLUMN     "withdrawalCount" INTEGER,
ADD COLUMN     "assetMintOrBurnCount" INTEGER,
ADD COLUMN     "redeemerCount" INTEGER,
ADD COLUMN     "validContract" BOOLEAN;

