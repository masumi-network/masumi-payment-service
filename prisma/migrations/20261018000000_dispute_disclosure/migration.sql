-- CreateTable
CREATE TABLE "DisputeDisclosure" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "blockchainIdentifier" TEXT NOT NULL,
    "encryptedInputData" TEXT,
    "encryptedResultData" TEXT,

    CONSTRAINT "DisputeDisclosure_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "DisputeDisclosure_blockchainIdentifier_key" ON "DisputeDisclosure"("blockchainIdentifier");
