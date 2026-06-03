-- Extend RegistrationState with the Update* phases used by the V2 registry
-- mint contract's UpdateAction (smart-contracts/registry-v2/validators/mint.ak).
-- UpdateAction atomically burns an existing registry asset and mints a
-- replacement with the same 1-byte nonce + 28-byte root_hash but version
-- incremented by one. The off-chain flow mirrors register/deregister:
--   UpdateRequested  → enqueued, awaiting the V2 update scheduler tick
--   UpdateInitiated  → tx submitted, awaiting on-chain confirmation
--   UpdateConfirmed  → new asset name observed on chain, agentIdentifier
--                      replaced with the bumped value
--   UpdateFailed     → terminal failure (operator inspect / retry path)
--
-- V1 has no equivalent on-chain action so the route layer rejects non-V2
-- payment sources up front; the enum is still globally extended because
-- PostgreSQL enums are global to the database.

ALTER TYPE "RegistrationState" ADD VALUE IF NOT EXISTS 'UpdateRequested';
ALTER TYPE "RegistrationState" ADD VALUE IF NOT EXISTS 'UpdateInitiated';
ALTER TYPE "RegistrationState" ADD VALUE IF NOT EXISTS 'UpdateConfirmed';
ALTER TYPE "RegistrationState" ADD VALUE IF NOT EXISTS 'UpdateFailed';
