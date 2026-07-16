-- Bind each reservation/refund to the grant version it consumed. Resetting a budget increments
-- this generation so a stale in-flight refund cannot credit a replacement grant.
ALTER TABLE "X402WalletBudget"
  ADD COLUMN "generation" INTEGER NOT NULL DEFAULT 0;
