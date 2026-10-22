ALTER TABLE "HydraLocalParticipant"
ADD COLUMN "commitWalletClaimToken" TEXT;

ALTER TABLE "HydraTopup"
ADD COLUMN "walletClaimToken" TEXT;
