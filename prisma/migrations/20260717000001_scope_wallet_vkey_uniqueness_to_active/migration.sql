-- Scope walletVkey uniqueness to active (non-soft-deleted) wallets. With the
-- global constraint, a soft-deleted fund wallet kept its vkey forever, so the
-- same mnemonic could never be re-registered — the funds became reachable only
-- by exporting the mnemonic into an external wallet. Active wallets keep the
-- exact same one-vkey-one-wallet guarantee.
DROP INDEX "HotWallet_walletVkey_key";

CREATE UNIQUE INDEX "HotWallet_active_walletVkey_key"
ON "HotWallet"("walletVkey")
WHERE "deletedAt" IS NULL;
