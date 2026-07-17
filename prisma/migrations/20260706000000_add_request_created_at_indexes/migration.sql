-- Payment/purchase list endpoints sort by "createdAt" DESC with cursor
-- pagination; without an index every filtered page sorts the full table.

CREATE INDEX "PaymentRequest_createdAt_id_idx" ON "PaymentRequest"("createdAt", "id");
CREATE INDEX "PurchaseRequest_createdAt_id_idx" ON "PurchaseRequest"("createdAt", "id");
