-- Add intendedTxHash + invalidHereafterSlot to Transaction.
--
-- These columns close the funding double-lock window (see #2 + #7 design):
--   * intendedTxHash: deterministic blake2b_256 of the signed tx body,
--     persisted BEFORE submitTx. Lets the reconciliation worker resolve an
--     ambiguous submit (e.g. submit threw after the node accepted) by
--     querying the chain for this exact hash.
--   * invalidHereafterSlot: the tx's invalid_hereafter slot. The
--     reconciliation worker waits until the current slot exceeds this (plus
--     a small grace) before marking an ambiguous Pending tx RolledBack —
--     after the TTL the ledger can never accept the txBody, so a fresh
--     attempt cannot double-spend.
--
-- Both columns are nullable; existing rows pre-dating this column will have
-- NULL and are handled by the legacy path (no reconciliation). Future
-- migrations can tighten to NOT NULL once the reconciliation worker has
-- backfilled all in-flight rows.

ALTER TABLE "Transaction"
ADD COLUMN IF NOT EXISTS "intendedTxHash" TEXT,
ADD COLUMN IF NOT EXISTS "invalidHereafterSlot" BIGINT;

-- Partial index supports the reconciliation worker's primary query:
-- WHERE status = 'Pending' AND txHash IS NULL AND intendedTxHash IS NOT NULL.
-- Partial index keeps it small — most rows have txHash set.
CREATE INDEX IF NOT EXISTS "Transaction_intendedTxHash_pending_idx"
ON "Transaction" ("intendedTxHash")
WHERE "txHash" IS NULL AND "intendedTxHash" IS NOT NULL;

-- Full index matching the Prisma schema's `@@index([intendedTxHash])`
-- declaration on the Transaction model. Prisma cannot express the partial
-- WHERE predicate above, so without this full index, a future
-- `prisma migrate dev` would consider the schema out of sync, generate a
-- DROP for the partial index it doesn't know about, and create a fresh
-- full index under a Prisma-canonical name. Pre-creating it here keeps the
-- schema/migration state consistent and lets the partial above continue to
-- serve as the small hot-path index for the reconciler.
CREATE INDEX IF NOT EXISTS "Transaction_intendedTxHash_idx"
ON "Transaction" ("intendedTxHash");
