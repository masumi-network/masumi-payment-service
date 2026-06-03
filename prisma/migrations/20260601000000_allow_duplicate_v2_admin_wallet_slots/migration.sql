-- V2 admin wallets are weighted slots. The same wallet address may appear
-- more than once to give that key more voting weight, while `order` remains
-- unique to keep off-chain signing order deterministic.

DROP INDEX IF EXISTS "AdminWallet_paymentSourceAdminId_walletAddress_active_key";
