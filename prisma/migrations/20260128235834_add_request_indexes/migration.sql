-- CreateIndex
CREATE INDEX "PaymentRequest_paymentSourceId_createdAt_idx" ON "PaymentRequest"("paymentSourceId", "createdAt");

-- CreateIndex
CREATE INDEX "PaymentRequest_paymentSourceId_onChainState_idx" ON "PaymentRequest"("paymentSourceId", "onChainState");

-- CreateIndex
CREATE INDEX "PaymentRequest_paymentSourceId_payByTime_idx" ON "PaymentRequest"("paymentSourceId", "payByTime");

-- CreateIndex
CREATE INDEX "PurchaseRequest_paymentSourceId_createdAt_idx" ON "PurchaseRequest"("paymentSourceId", "createdAt");

-- CreateIndex
CREATE INDEX "PurchaseRequest_paymentSourceId_onChainState_idx" ON "PurchaseRequest"("paymentSourceId", "onChainState");

-- CreateIndex
CREATE INDEX "PurchaseRequest_paymentSourceId_payByTime_idx" ON "PurchaseRequest"("paymentSourceId", "payByTime");
