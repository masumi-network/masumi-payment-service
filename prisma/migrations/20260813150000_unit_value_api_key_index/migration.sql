-- Index the credit ledger by owner.
--
-- UnitValue had no index beyond its primary key. Postgres does not index foreign
-- keys automatically, so every usage-limited purchase and every x402 payment
-- sequentially scanned a table that holds one row per PaidFunds and withdrawal
-- entry of every payment ever made — and did so inside Serializable
-- transactions, where a sequential scan escalates predicate locking to the whole
-- relation and turns otherwise unrelated concurrent purchases into
-- serialization-conflict partners.
--
-- CONCURRENTLY is deliberately NOT used: Prisma runs each migration inside a
-- transaction, which CONCURRENTLY cannot participate in. These tables are small
-- enough at current scale that the brief ACCESS SHARE-blocking build is
-- acceptable; on a very large deployment, build them out-of-band first and this
-- migration becomes a no-op via IF NOT EXISTS.
CREATE INDEX IF NOT EXISTS "UnitValue_apiKeyId_idx" ON "UnitValue"("apiKeyId");
CREATE INDEX IF NOT EXISTS "UnitValue_apiKeyId_unit_idx" ON "UnitValue"("apiKeyId", "unit");
