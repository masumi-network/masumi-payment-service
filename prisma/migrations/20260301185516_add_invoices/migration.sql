-- CreateEnum
CREATE TYPE "SymbolPosition" AS ENUM ('Before', 'After');

-- AlterTable
ALTER TABLE "PaymentRequest" ADD COLUMN     "invoiceBaseId" TEXT;

-- CreateTable
CREATE TABLE "InvoiceBase" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "invoiceId" TEXT NOT NULL,

    CONSTRAINT "InvoiceBase_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InvoiceRevision" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "invoiceBaseId" TEXT NOT NULL,
    "revisionNumber" INTEGER NOT NULL DEFAULT 0,
    "currencyShortId" TEXT NOT NULL,
    "invoiceTitle" TEXT NOT NULL,
    "invoiceDescription" TEXT,
    "invoiceDate" TIMESTAMP(3) NOT NULL,
    "invoiceMonth" INTEGER NOT NULL,
    "invoiceYear" INTEGER NOT NULL,
    "reverseCharge" BOOLEAN NOT NULL,
    "invoiceGreetings" TEXT,
    "invoiceClosing" TEXT,
    "invoiceSignature" TEXT,
    "invoiceLogo" TEXT,
    "invoiceFooter" TEXT,
    "invoiceTerms" TEXT,
    "invoicePrivacy" TEXT,
    "invoiceDisclaimer" TEXT,
    "language" TEXT,
    "localizationFormat" TEXT NOT NULL,
    "sellerCountry" TEXT NOT NULL,
    "sellerCity" TEXT NOT NULL,
    "sellerZipCode" TEXT NOT NULL,
    "sellerStreet" TEXT NOT NULL,
    "sellerStreetNumber" TEXT NOT NULL,
    "sellerEmail" TEXT,
    "sellerPhone" TEXT,
    "sellerName" TEXT,
    "sellerCompanyName" TEXT,
    "sellerVatNumber" TEXT,
    "sellerWalletAddress" TEXT,
    "buyerCountry" TEXT NOT NULL,
    "buyerCity" TEXT NOT NULL,
    "buyerZipCode" TEXT NOT NULL,
    "buyerStreet" TEXT NOT NULL,
    "buyerStreetNumber" TEXT NOT NULL,
    "buyerEmail" TEXT,
    "buyerPhone" TEXT,
    "buyerName" TEXT,
    "buyerCompanyName" TEXT,
    "buyerVatNumber" TEXT,
    "buyerWalletAddress" TEXT,
    "generatedPDFInvoice" BYTEA NOT NULL,
    "generatedInvoiceUpdatedAt" TIMESTAMP(3) NOT NULL,
    "isCancelled" BOOLEAN NOT NULL DEFAULT false,
    "cancellationReason" TEXT,
    "cancellationDate" TIMESTAMP(3),
    "cancellationId" TEXT,
    "generatedCancelledInvoice" BYTEA,
    "generatedCancelledInvoiceUpdatedAt" TIMESTAMP(3),

    CONSTRAINT "InvoiceRevision_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InvoicePrefix" (
    "id" TEXT NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "InvoicePrefix_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InvoiceItem" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "name" TEXT NOT NULL,
    "quantity" DECIMAL(65,30) NOT NULL,
    "pricePerUnitWithoutVat" DECIMAL(65,30) NOT NULL,
    "vatRate" DECIMAL(65,30) NOT NULL,
    "vatAmount" DECIMAL(65,30) NOT NULL,
    "totalAmount" DECIMAL(65,30) NOT NULL,
    "decimals" INTEGER NOT NULL,
    "conversionFactor" DECIMAL(65,30) NOT NULL,
    "convertedUnit" TEXT NOT NULL,
    "conversionDate" TIMESTAMP(3) NOT NULL,
    "referencedPaymentId" TEXT,
    "invoiceRevisionId" TEXT NOT NULL,

    CONSTRAINT "InvoiceItem_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "InvoiceBase_invoiceId_key" ON "InvoiceBase"("invoiceId");

-- CreateIndex
CREATE UNIQUE INDEX "InvoiceRevision_cancellationId_key" ON "InvoiceRevision"("cancellationId");

-- CreateIndex
CREATE UNIQUE INDEX "InvoiceRevision_invoiceBaseId_revisionNumber_key" ON "InvoiceRevision"("invoiceBaseId", "revisionNumber");

-- AddForeignKey
ALTER TABLE "PaymentRequest" ADD CONSTRAINT "PaymentRequest_invoiceBaseId_fkey" FOREIGN KEY ("invoiceBaseId") REFERENCES "InvoiceBase"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InvoiceRevision" ADD CONSTRAINT "InvoiceRevision_invoiceBaseId_fkey" FOREIGN KEY ("invoiceBaseId") REFERENCES "InvoiceBase"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InvoiceItem" ADD CONSTRAINT "InvoiceItem_referencedPaymentId_fkey" FOREIGN KEY ("referencedPaymentId") REFERENCES "PaymentRequest"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InvoiceItem" ADD CONSTRAINT "InvoiceItem_invoiceRevisionId_fkey" FOREIGN KEY ("invoiceRevisionId") REFERENCES "InvoiceRevision"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
