-- CreateEnum
CREATE TYPE "SimpleApiStatus" AS ENUM ('Online', 'Offline', 'Invalid', 'Deregistered');

-- CreateTable
CREATE TABLE "SimpleApiListing" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "registryListingId" TEXT NOT NULL,
    "urlHash" TEXT NOT NULL,
    "network" "Network" NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "url" TEXT NOT NULL,
    "category" TEXT,
    "tags" TEXT[],
    "httpMethod" TEXT,
    "status" "SimpleApiStatus" NOT NULL,
    "lastActiveAt" TIMESTAMP(3),
    "statusUpdatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSyncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "paymentScheme" TEXT,
    "x402Network" TEXT,
    "maxAmountRequired" BIGINT,
    "payTo" TEXT,
    "asset" TEXT,
    "resource" TEXT,
    "mimeType" TEXT,
    "rawAccepts" JSONB NOT NULL,
    "extra" JSONB,

    CONSTRAINT "SimpleApiListing_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SimpleApiPaymentRecord" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "listingId" TEXT NOT NULL,
    "registryListingId" TEXT NOT NULL,
    "requestedById" TEXT NOT NULL,
    "paymentNetwork" TEXT NOT NULL,
    "paymentScheme" TEXT NOT NULL,
    "amountPaid" TEXT NOT NULL,
    "payTo" TEXT NOT NULL,
    "asset" TEXT NOT NULL,
    "resource" TEXT NOT NULL,
    "facilitatorSettlementId" TEXT,
    "xPaymentHeader" TEXT NOT NULL,

    CONSTRAINT "SimpleApiPaymentRecord_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SimpleApiListing_registryListingId_key" ON "SimpleApiListing"("registryListingId");

-- CreateIndex
CREATE UNIQUE INDEX "SimpleApiListing_urlHash_key" ON "SimpleApiListing"("urlHash");

-- CreateIndex
CREATE INDEX "SimpleApiListing_network_status_idx" ON "SimpleApiListing"("network", "status");

-- CreateIndex
CREATE INDEX "SimpleApiListing_statusUpdatedAt_idx" ON "SimpleApiListing"("statusUpdatedAt");

-- CreateIndex
CREATE INDEX "SimpleApiListing_statusUpdatedAt_id_idx" ON "SimpleApiListing"("statusUpdatedAt", "id");

-- CreateIndex
CREATE INDEX "SimpleApiPaymentRecord_listingId_idx" ON "SimpleApiPaymentRecord"("listingId");

-- CreateIndex
CREATE INDEX "SimpleApiPaymentRecord_requestedById_idx" ON "SimpleApiPaymentRecord"("requestedById");

-- CreateIndex
CREATE INDEX "SimpleApiPaymentRecord_createdAt_idx" ON "SimpleApiPaymentRecord"("createdAt");

-- AddForeignKey
ALTER TABLE "SimpleApiPaymentRecord" ADD CONSTRAINT "SimpleApiPaymentRecord_listingId_fkey" FOREIGN KEY ("listingId") REFERENCES "SimpleApiListing"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SimpleApiPaymentRecord" ADD CONSTRAINT "SimpleApiPaymentRecord_requestedById_fkey" FOREIGN KEY ("requestedById") REFERENCES "ApiKey"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
