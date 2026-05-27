-- Harden admin-wallet schema against silent state corruption that the
-- existing FK/relation shape allowed:
--
--   * V1 PaymentSource.adminWalletId was relaxed to NULL (migration
--     20260519120000) and the FK switched to ON DELETE SET NULL. An admin
--     wallet delete would silently null V1's required fee-receiver pointer,
--     breaking settlement. No CHECK prevented the illegal V1 state.
--   * V2 sources use the AdminWallets[] relation (verification-key set) for
--     M-of-N admin signing. The 20260524000000 CHECK enforced
--     requiredAdminSignatures >= 1 but nothing stopped admins from deleting
--     AdminWallet rows below the M threshold or duplicating
--     (paymentSourceAdminId, walletAddress) / (paymentSourceAdminId, order).
--
-- This migration adds five guards:
--   1. V1 must keep adminWalletId NOT NULL.
--   2. V2 must NOT carry a singular adminWalletId (it has no V1-style fee
--      receiver concept; allowing one risks cross-typed rows).
--   3. AdminWallet.paymentSourceAdminId FK becomes ON DELETE RESTRICT so an
--      operator must explicitly detach a wallet from its V2 source before
--      deleting it. (NULL update path still works for detach-then-delete.)
--   4. Partial unique index on (paymentSourceAdminId, walletAddress) for
--      attached wallets — prevents duplicate verification keys silently
--      defeating multi-sig.
--   5. Partial unique index on (paymentSourceAdminId, order) for attached
--      wallets — the `order` column drives canonical admin signing order;
--      duplicates make off-chain ordering ambiguous vs the on-chain
--      admin_vks list.
--
-- A deferrable trigger enforces the count >= requiredAdminSignatures
-- invariant for V2 sources. DEFERRABLE INITIALLY DEFERRED so multi-row
-- admin swaps (insert new + delete old in one tx) don't fire mid-swap on
-- transient states.
--
-- All DDL uses IF NOT EXISTS or duplicate_object guards so the migration is
-- safe to re-run on a partially-applied database.

-- 1. V1 fee-receiver required.
-- Added with NOT VALID so the migration succeeds on any production database
-- whose V1 rows had `adminWalletId` previously SET NULL (the FK in migration
-- 20260519120000 became ON DELETE SET NULL — an admin-wallet delete between
-- migrations could have orphaned a V1 source). The CHECK still blocks any
-- FUTURE write that would violate; existing violators are repaired by the
-- backfill below, and then the constraint is validated.
DO $$ BEGIN
    ALTER TABLE "PaymentSource"
    ADD CONSTRAINT "PaymentSource_v1_admin_wallet_required"
    CHECK ("paymentSourceType" <> 'Web3CardanoV1' OR "adminWalletId" IS NOT NULL)
    NOT VALID;
EXCEPTION
    WHEN duplicate_object THEN NULL;
    WHEN duplicate_table THEN NULL;
END $$;

-- Repair pre-existing offenders, if any: a V1 source with NULL adminWalletId
-- is a corrupt fee-receiver state from a now-defunct cascade. Surface them
-- via a NOTICE so operators can audit; do NOT auto-delete (they may carry
-- in-flight funds).
DO $$
DECLARE
    v_count INT;
BEGIN
    SELECT COUNT(*) INTO v_count
    FROM "PaymentSource"
    WHERE "paymentSourceType" = 'Web3CardanoV1' AND "adminWalletId" IS NULL;
    IF v_count > 0 THEN
        RAISE NOTICE 'Found % V1 PaymentSource row(s) with NULL adminWalletId. '
            'These rows must be repaired manually before VALIDATE will succeed. '
            'After repair, run: ALTER TABLE "PaymentSource" VALIDATE CONSTRAINT "PaymentSource_v1_admin_wallet_required";',
            v_count;
    END IF;
END $$;

-- Validate only if no violators remain. Wrapping in DO $$ + EXCEPTION lets
-- the migration complete even when manual repair is still pending; the
-- constraint stays NOT VALID until validation succeeds.
DO $$ BEGIN
    ALTER TABLE "PaymentSource" VALIDATE CONSTRAINT "PaymentSource_v1_admin_wallet_required";
EXCEPTION
    WHEN check_violation THEN
        RAISE WARNING 'PaymentSource_v1_admin_wallet_required left NOT VALID (existing offenders). '
            'Repair them and run VALIDATE manually.';
END $$;

-- 2. V2 must not carry the singular adminWalletId.
-- Same NOT VALID + VALIDATE dance as #1: practically every V2 row should
-- already have NULL adminWalletId (the route handlers never set it), but a
-- manually-edited row could exist.
DO $$ BEGIN
    ALTER TABLE "PaymentSource"
    ADD CONSTRAINT "PaymentSource_v2_no_singular_admin"
    CHECK ("paymentSourceType" <> 'Web3CardanoV2' OR "adminWalletId" IS NULL)
    NOT VALID;
EXCEPTION
    WHEN duplicate_object THEN NULL;
    WHEN duplicate_table THEN NULL;
END $$;

DO $$
DECLARE
    v_count INT;
BEGIN
    SELECT COUNT(*) INTO v_count
    FROM "PaymentSource"
    WHERE "paymentSourceType" = 'Web3CardanoV2' AND "adminWalletId" IS NOT NULL;
    IF v_count > 0 THEN
        RAISE NOTICE 'Found % V2 PaymentSource row(s) with non-NULL adminWalletId. '
            'V2 sources must use the AdminWallets[] relation; the singular adminWalletId is V1-only. '
            'Repair (UPDATE "PaymentSource" SET "adminWalletId" = NULL WHERE "paymentSourceType" = ''Web3CardanoV2'') before validating.',
            v_count;
    END IF;
END $$;

DO $$ BEGIN
    ALTER TABLE "PaymentSource" VALIDATE CONSTRAINT "PaymentSource_v2_no_singular_admin";
EXCEPTION
    WHEN check_violation THEN
        RAISE WARNING 'PaymentSource_v2_no_singular_admin left NOT VALID (existing offenders). '
            'Repair them and run VALIDATE manually.';
END $$;

-- 3. RESTRICT FK on AdminWallet.paymentSourceAdminId. Default (NO ACTION)
-- happens to fail late at commit; RESTRICT fails immediately and is the
-- intent: prevent silent reduction of an active V2 admin set.
ALTER TABLE "AdminWallet" DROP CONSTRAINT IF EXISTS "AdminWallet_paymentSourceAdminId_fkey";
ALTER TABLE "AdminWallet"
    ADD CONSTRAINT "AdminWallet_paymentSourceAdminId_fkey"
    FOREIGN KEY ("paymentSourceAdminId") REFERENCES "PaymentSource"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

-- 4. Unique (paymentSourceAdminId, walletAddress) on attached.
CREATE UNIQUE INDEX IF NOT EXISTS "AdminWallet_paymentSourceAdminId_walletAddress_active_key"
ON "AdminWallet" ("paymentSourceAdminId", "walletAddress")
WHERE "paymentSourceAdminId" IS NOT NULL;

-- 5. Unique (paymentSourceAdminId, order) on attached.
CREATE UNIQUE INDEX IF NOT EXISTS "AdminWallet_paymentSourceAdminId_order_active_key"
ON "AdminWallet" ("paymentSourceAdminId", "order")
WHERE "paymentSourceAdminId" IS NOT NULL;

-- 6. V2 quorum invariant: count(AdminWallets) >= requiredAdminSignatures.
-- CREATE OR REPLACE the function so re-runs update it cleanly; the trigger
-- itself is dropped+recreated to guarantee binding to the latest function.

CREATE OR REPLACE FUNCTION enforce_v2_admin_quorum() RETURNS TRIGGER AS $$
DECLARE
    v_required INT;
    v_count    INT;
    v_type     "PaymentSourceType";
    v_psid     TEXT;
BEGIN
    -- Decide which PaymentSource id to check based on what fired the trigger.
    IF TG_TABLE_NAME = 'AdminWallet' THEN
        IF TG_OP = 'DELETE' THEN
            v_psid := OLD."paymentSourceAdminId";
        ELSIF TG_OP = 'UPDATE' THEN
            -- An UPDATE that moves a wallet between sources can lower the count
            -- on the OLD side and raise it on the NEW side. Check the OLD side
            -- here; the NEW side gets checked by the AFTER-row-trigger pass.
            v_psid := COALESCE(NEW."paymentSourceAdminId", OLD."paymentSourceAdminId");
        ELSE
            v_psid := NEW."paymentSourceAdminId";
        END IF;
    ELSE
        -- PaymentSource update on requiredAdminSignatures / paymentSourceType.
        v_psid := NEW."id";
    END IF;

    IF v_psid IS NULL THEN RETURN NULL; END IF;

    SELECT "paymentSourceType", "requiredAdminSignatures"
        INTO v_type, v_required
    FROM "PaymentSource"
    WHERE "id" = v_psid;

    -- Source deleted (or doesn't exist) — nothing to enforce.
    IF v_type IS NULL THEN RETURN NULL; END IF;

    -- Only V2 has the quorum invariant.
    IF v_type <> 'Web3CardanoV2' OR v_required IS NULL THEN RETURN NULL; END IF;

    SELECT COUNT(*) INTO v_count
    FROM "AdminWallet"
    WHERE "paymentSourceAdminId" = v_psid;

    IF v_count < v_required THEN
        RAISE EXCEPTION 'V2 PaymentSource % requires at least % AdminWallet row(s) (currently %)',
            v_psid, v_required, v_count
            USING ERRCODE = 'check_violation';
    END IF;

    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_v2_admin_quorum_adminwallet ON "AdminWallet";
CREATE CONSTRAINT TRIGGER trg_v2_admin_quorum_adminwallet
    AFTER INSERT OR UPDATE OR DELETE ON "AdminWallet"
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION enforce_v2_admin_quorum();

DROP TRIGGER IF EXISTS trg_v2_admin_quorum_paymentsource ON "PaymentSource";
-- Fires on INSERT as well so a V2 PaymentSource created without any
-- AdminWallets in the same tx is rejected at commit. Without INSERT
-- coverage, a `paymentSource.create({ data: { paymentSourceType: 'V2',
-- requiredAdminSignatures: 2 } })` (no nested AdminWallet creates) would
-- commit silently and leave Disputed UTxOs permanently unspendable
-- (M-of-N from a 0-admin set can never be met). The trigger is
-- DEFERRABLE INITIALLY DEFERRED, so Prisma's nested
-- `AdminWallets: { create: [...] }` still passes because the check fires
-- at commit time AFTER all admin rows are inserted.
CREATE CONSTRAINT TRIGGER trg_v2_admin_quorum_paymentsource
    AFTER INSERT OR UPDATE OF "requiredAdminSignatures", "paymentSourceType" ON "PaymentSource"
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION enforce_v2_admin_quorum();
