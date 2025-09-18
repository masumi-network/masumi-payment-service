-- CreateIndex
CREATE INDEX IF NOT EXISTS "RegistryRequest_agentIdentifier_idx" ON "RegistryRequest"("agentIdentifier");

-- CreateIndex  
CREATE INDEX IF NOT EXISTS "RegistryRequest_paymentSourceId_idx" ON "RegistryRequest"("paymentSourceId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "RegistryRequest_state_idx" ON "RegistryRequest"("state");