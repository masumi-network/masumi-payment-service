-- One active fund wallet per payment source. The predicate deliberately
-- excludes soft-deleted wallets so an operator can replace a retired wallet.
-- This is separate from the enum migration because Postgres cannot use a new
-- enum value in the same transaction that adds it.
CREATE UNIQUE INDEX "HotWallet_active_funding_paymentSourceId_key"
ON "HotWallet"("paymentSourceId")
WHERE "type" = 'Funding' AND "deletedAt" IS NULL;
