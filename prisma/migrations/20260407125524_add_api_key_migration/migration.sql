-- DropIndex
DROP INDEX "ApiKey_token_key";

-- AlterTable
ALTER TABLE "ApiKey" ADD COLUMN     "encryptedToken" TEXT;
