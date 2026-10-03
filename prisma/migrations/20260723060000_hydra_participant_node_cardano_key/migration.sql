-- Decouple the Hydra head participant's on-chain identity (the node's own Cardano
-- key that participant tokens are minted for) from the funding hot wallet. Adds a
-- `cardanoVkey` (28-byte key-hash hex) per participant; InitTx verification now
-- checks the on-chain participant tokens against THIS key, not the funding wallet.
--
-- Backfill existing rows from the funding wallet's vkey so any legacy head that
-- was created under the old coupled model keeps verifying unchanged. New heads set
-- cardanoVkey to the node's dedicated Cardano key.

ALTER TABLE "HydraLocalParticipant" ADD COLUMN "cardanoVkey" TEXT;
UPDATE "HydraLocalParticipant" p
SET "cardanoVkey" = hw."walletVkey"
FROM "HotWallet" hw
WHERE hw."id" = p."walletId";
ALTER TABLE "HydraLocalParticipant" ALTER COLUMN "cardanoVkey" SET NOT NULL;

ALTER TABLE "HydraRemoteParticipant" ADD COLUMN "cardanoVkey" TEXT;
UPDATE "HydraRemoteParticipant" p
SET "cardanoVkey" = wb."walletVkey"
FROM "WalletBase" wb
WHERE wb."id" = p."walletId";
ALTER TABLE "HydraRemoteParticipant" ALTER COLUMN "cardanoVkey" SET NOT NULL;
