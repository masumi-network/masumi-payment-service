-- Retire the legacy PaymentType enum on RegistryRequest. The canonical source
-- of truth for "does this registry entry advertise payment metadata, and which
-- kinds" is now the SupportedPaymentSource child table introduced in the
-- previous migration.
--
-- NOTE: the column and enum were already removed by an earlier migration
-- (20260410103222_remove_unused_payment_type) in some environments. The
-- IF EXISTS guards make this migration idempotent so that environments which
-- already dropped the column/enum do not error here.
ALTER TABLE "RegistryRequest" DROP COLUMN IF EXISTS "paymentType";

DROP TYPE IF EXISTS "PaymentType";
