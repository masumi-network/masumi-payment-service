-- CreateTable
CREATE TABLE "PaymentSourceIdentifiers" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "txHash" TEXT NOT NULL,
    "paymentSourceId" TEXT NOT NULL,

    CONSTRAINT "PaymentSourceIdentifiers_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PaymentSourceIdentifiers_txHash_key" ON "PaymentSourceIdentifiers"("txHash");

-- AddForeignKey
ALTER TABLE "PaymentSourceIdentifiers" ADD CONSTRAINT "PaymentSourceIdentifiers_paymentSourceId_fkey" FOREIGN KEY ("paymentSourceId") REFERENCES "PaymentSource"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
