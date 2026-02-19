-- CreateTable
CREATE TABLE "ApiKeyPaymentSourceScope" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "apiKeyId" TEXT NOT NULL,
    "paymentSourceId" TEXT NOT NULL,

    CONSTRAINT "ApiKeyPaymentSourceScope_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ApiKeyPaymentSourceScope_apiKeyId_idx" ON "ApiKeyPaymentSourceScope"("apiKeyId");

-- CreateIndex
CREATE INDEX "ApiKeyPaymentSourceScope_paymentSourceId_idx" ON "ApiKeyPaymentSourceScope"("paymentSourceId");

-- CreateIndex
CREATE UNIQUE INDEX "ApiKeyPaymentSourceScope_apiKeyId_paymentSourceId_key" ON "ApiKeyPaymentSourceScope"("apiKeyId", "paymentSourceId");

-- AddForeignKey
ALTER TABLE "ApiKeyPaymentSourceScope" ADD CONSTRAINT "ApiKeyPaymentSourceScope_apiKeyId_fkey" FOREIGN KEY ("apiKeyId") REFERENCES "ApiKey"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApiKeyPaymentSourceScope" ADD CONSTRAINT "ApiKeyPaymentSourceScope_paymentSourceId_fkey" FOREIGN KEY ("paymentSourceId") REFERENCES "PaymentSource"("id") ON DELETE CASCADE ON UPDATE CASCADE;
