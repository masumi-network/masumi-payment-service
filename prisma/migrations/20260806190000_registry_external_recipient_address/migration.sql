-- Allow registry mints to target external bech32 addresses (browser / paper wallets).
ALTER TABLE "RegistryRequest"
ADD COLUMN "recipientWalletAddress" TEXT;

ALTER TABLE "InboxAgentRegistrationRequest"
ADD COLUMN "recipientWalletAddress" TEXT;
