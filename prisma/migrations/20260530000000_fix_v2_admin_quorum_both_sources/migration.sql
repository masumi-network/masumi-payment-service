-- Fix: the V2 admin-quorum trigger only validated ONE PaymentSource on an
-- AdminWallet UPDATE.
--
-- The original `enforce_v2_admin_quorum()` (migration
-- 20260526001000_harden_admin_wallet_constraints) computed the source to check
-- as `COALESCE(NEW.paymentSourceAdminId, OLD.paymentSourceAdminId)` on UPDATE —
-- i.e. the NEW side. When an AdminWallet is MOVED between sources
-- (paymentSourceAdminId A -> B), that lowers the admin count on the OLD source
-- A and raises it on the NEW source B, but only B was validated. The abandoned
-- source A could silently drop below its M-of-N `requiredAdminSignatures`
-- threshold, making every Disputed UTxO on A permanently unredeemable (the
-- on-chain multisig quorum can never again be met).
--
-- Fix: on UPDATE, validate BOTH the OLD and the NEW source. We generalize the
-- function to check the set of affected source ids in a loop, so DELETE / INSERT
-- / PaymentSource-update paths keep their exact prior single-source semantics
-- while the wallet-move UPDATE path now covers the source it left.
--
-- Only the function body changes; the two CONSTRAINT TRIGGERs created by
-- 20260526001000 reference this function BY NAME, so `CREATE OR REPLACE
-- FUNCTION` is picked up automatically — no trigger recreation needed. The
-- statement is idempotent and safe to re-run.

CREATE OR REPLACE FUNCTION enforce_v2_admin_quorum() RETURNS TRIGGER AS $$
DECLARE
    v_required INT;
    v_count    INT;
    v_type     "PaymentSourceType";
    v_psids    TEXT[];
    v_psid     TEXT;
BEGIN
    -- Collect EVERY PaymentSource id whose admin set this row event could have
    -- changed. The critical case is an AdminWallet UPDATE that MOVES a wallet
    -- between sources: BOTH the OLD (count decremented) and NEW (count
    -- incremented) sides must satisfy the quorum invariant afterward.
    IF TG_TABLE_NAME = 'AdminWallet' THEN
        IF TG_OP = 'DELETE' THEN
            v_psids := ARRAY[OLD."paymentSourceAdminId"];
        ELSIF TG_OP = 'UPDATE' THEN
            -- Check both sides. If the wallet did not move, NEW == OLD and the
            -- duplicate is harmless (the same source is validated twice).
            v_psids := ARRAY[NEW."paymentSourceAdminId", OLD."paymentSourceAdminId"];
        ELSE
            v_psids := ARRAY[NEW."paymentSourceAdminId"];
        END IF;
    ELSE
        -- PaymentSource update on requiredAdminSignatures / paymentSourceType,
        -- or insert.
        v_psids := ARRAY[NEW."id"];
    END IF;

    FOREACH v_psid IN ARRAY v_psids LOOP
        IF v_psid IS NULL THEN
            CONTINUE;
        END IF;

        SELECT "paymentSourceType", "requiredAdminSignatures"
            INTO v_type, v_required
        FROM "PaymentSource"
        WHERE "id" = v_psid;

        -- Source deleted (or doesn't exist) — nothing to enforce for it.
        IF v_type IS NULL THEN
            CONTINUE;
        END IF;

        -- Only V2 carries the quorum invariant.
        IF v_type <> 'Web3CardanoV2' OR v_required IS NULL THEN
            CONTINUE;
        END IF;

        SELECT COUNT(*) INTO v_count
        FROM "AdminWallet"
        WHERE "paymentSourceAdminId" = v_psid;

        IF v_count < v_required THEN
            RAISE EXCEPTION 'V2 PaymentSource % requires at least % AdminWallet row(s) (currently %)',
                v_psid, v_required, v_count
                USING ERRCODE = 'check_violation';
        END IF;
    END LOOP;

    RETURN NULL;
END;
$$ LANGUAGE plpgsql;
