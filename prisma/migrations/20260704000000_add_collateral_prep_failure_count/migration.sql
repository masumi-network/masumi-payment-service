-- Bounded collateral-prep retry: count consecutive prep_tx_failed attempts per
-- registry / inbox request so a deterministically-failing collateral prep
-- surfaces as *Failed instead of retrying silently forever. Additive; existing
-- rows default to 0.
ALTER TABLE "RegistryRequest" ADD COLUMN     "collateralPrepFailureCount" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "InboxAgentRegistrationRequest" ADD COLUMN     "collateralPrepFailureCount" INTEGER NOT NULL DEFAULT 0;
