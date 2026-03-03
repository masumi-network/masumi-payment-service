-- Add indexes for nextActionOrOnChainStateOrResultLastChangedAt column
-- These indexes support the optimized diff-pattern queries in the state transition monitor

-- PaymentRequest: index for efficient diff queries on combined timestamp
CREATE INDEX "PaymentRequest_combinedLastChangedAt_idx" ON "PaymentRequest"("nextActionOrOnChainStateOrResultLastChangedAt");

-- PaymentRequest: composite index for cursor-based pagination (timestamp, id)
CREATE INDEX "PaymentRequest_combinedLastChangedAt_id_idx" ON "PaymentRequest"("nextActionOrOnChainStateOrResultLastChangedAt", "id");

-- PurchaseRequest: index for efficient diff queries on combined timestamp
CREATE INDEX "PurchaseRequest_combinedLastChangedAt_idx" ON "PurchaseRequest"("nextActionOrOnChainStateOrResultLastChangedAt");

-- PurchaseRequest: composite index for cursor-based pagination (timestamp, id)
CREATE INDEX "PurchaseRequest_combinedLastChangedAt_id_idx" ON "PurchaseRequest"("nextActionOrOnChainStateOrResultLastChangedAt", "id");
