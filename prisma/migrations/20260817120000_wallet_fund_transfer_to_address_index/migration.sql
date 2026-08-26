-- The Hydra node-funding claim looks a transfer up by destination address
-- inside a Serializable transaction, and the head transaction history reads
-- the same column per admin page load. A sequential scan there takes a
-- relation-wide predicate lock, so any concurrent insert into this table
-- becomes a serialization conflict.
CREATE INDEX "WalletFundTransfer_toAddress_createdAt_idx" ON "WalletFundTransfer"("toAddress", "createdAt");
