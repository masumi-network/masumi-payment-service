-- Let an operator take a one-time backup of a node's signing keys.
--
-- The Hydra Host generates both keys and discloses them exactly once, at
-- provisioning. This service already kept the Hydra key so it would not exist
-- only on the Host's disk; the Cardano key was received in the same response
-- and thrown away, which left the node's on-chain identity unrecoverable if
-- that disk died. Keeping it closes that gap.
--
-- `keysDisclosedAt` seals the new reveal endpoint after its first use, so the
-- database copy cannot be pulled out through the API repeatedly.

ALTER TABLE "HydraSecretKey" ADD COLUMN "cardanoSK" TEXT;
ALTER TABLE "HydraLocalParticipant" ADD COLUMN "keysDisclosedAt" TIMESTAMP(3);
