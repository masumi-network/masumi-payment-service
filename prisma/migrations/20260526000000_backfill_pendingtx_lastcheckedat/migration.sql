-- Backfill Transaction.lastCheckedAt for any row currently NULL whose
-- BlocksWallet relation is active (i.e. it IS a PendingTransaction in the
-- sense wallet-timeouts polls).
--
-- Background: wallet-timeouts/service.ts filtered `PendingTransaction.lastCheckedAt: { lte: ... }`,
-- and Prisma's `lte` does NOT match NULL. Any historical PendingTransaction
-- with NULL lastCheckedAt was therefore invisible to the recovery cron AND
-- to the orphan-lock branch (which requires pendingTransactionId == null) —
-- the wallet stayed locked forever.
--
-- The application-level fix added the NULL branch to the filter, so the
-- cron now handles NULL going forward. This backfill closes the historical
-- gap so the next cron tick can immediately recover any already-stranded
-- wallet without having to wait for a future write to seed lastCheckedAt.
--
-- Conservative: only backfills rows where lastCheckedAt IS NULL AND the row
-- is still actively referenced from a HotWallet (HotWallet.pendingTransactionId
-- pointing here). Standalone Transaction rows with NULL lastCheckedAt that
-- aren't anyone's PendingTransaction are not touched (they'd be cleanup
-- candidates for a separate audit, not for this targeted backfill).

DO $$
DECLARE
    affected_count INT;
BEGIN
    UPDATE "Transaction" t
    SET "lastCheckedAt" = COALESCE(t."createdAt", NOW())
    WHERE t."lastCheckedAt" IS NULL
      AND EXISTS (
        SELECT 1
        FROM "HotWallet" hw
        WHERE hw."pendingTransactionId" = t."id"
      );

    GET DIAGNOSTICS affected_count = ROW_COUNT;
    IF affected_count > 0 THEN
        RAISE NOTICE 'Backfilled lastCheckedAt on % PendingTransaction row(s) previously stranded by NULL filter mismatch.', affected_count;
    END IF;
END $$;
