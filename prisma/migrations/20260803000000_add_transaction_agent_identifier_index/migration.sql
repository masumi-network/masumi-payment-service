-- Serves `filterAgentIdentifier` on the payment/purchase list and count endpoints.
-- Consumers (notably the Masumi SaaS activity feed and per-agent transaction list)
-- previously pulled a fixed page of every transaction on a payment source and
-- filtered by agent in memory, which silently truncated results. Pushing that
-- filter into the query only helps if it can be answered from an index — neither
-- table had one on agentIdentifier.
--
-- createdAt trails the identifier so the index also satisfies the `ORDER BY
-- createdAt DESC` these endpoints apply, avoiding a sort of every matching row.

CREATE INDEX IF NOT EXISTS "PaymentRequest_agentIdentifier_createdAt_idx"
  ON "PaymentRequest"("agentIdentifier", "createdAt");

CREATE INDEX IF NOT EXISTS "PurchaseRequest_agentIdentifier_createdAt_idx"
  ON "PurchaseRequest"("agentIdentifier", "createdAt");
