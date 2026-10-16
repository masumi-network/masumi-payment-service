-- Serves `filterAgentIdentifier` on the payment list and count endpoints.
-- Consumers (notably the Masumi SaaS activity feed and per-agent transaction
-- list) previously pulled a fixed page of every transaction on a payment source
-- and filtered by agent in memory, which silently truncated results. Pushing
-- that filter into the query only helps if it can be answered from an index,
-- and this table had none on agentIdentifier.
--
-- createdAt trails the identifier so a SINGLE-identifier lookup also gets its
-- `ORDER BY createdAt DESC` from the index. That does not extend to a
-- multi-identifier list: a btree scan over several leading-key values returns
-- rows grouped by identifier, so Postgres still sorts. The suffix is kept
-- because one agent is the dominant case for these endpoints.
--
-- CONCURRENTLY is deliberately NOT used: Prisma runs each migration inside a
-- transaction, which CONCURRENTLY cannot participate in. The PurchaseRequest
-- index is a separate migration so each table's write-blocking SHARE lock
-- covers only its own build. On a very large deployment, build these
-- out-of-band first and these migrations become no-ops via IF NOT EXISTS.

CREATE INDEX IF NOT EXISTS "PaymentRequest_agentIdentifier_createdAt_idx"
  ON "PaymentRequest"("agentIdentifier", "createdAt");
