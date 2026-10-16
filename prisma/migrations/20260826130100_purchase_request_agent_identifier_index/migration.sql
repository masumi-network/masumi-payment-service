-- PurchaseRequest half of the agentIdentifier index; see the rationale and the
-- CONCURRENTLY note in 20260826130000_payment_request_agent_identifier_index.
-- Kept in its own migration so the write-blocking SHARE lock this build takes
-- on PurchaseRequest is not held for the duration of the PaymentRequest build
-- as well.

CREATE INDEX IF NOT EXISTS "PurchaseRequest_agentIdentifier_createdAt_idx"
  ON "PurchaseRequest"("agentIdentifier", "createdAt");
