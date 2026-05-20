-- Retire the legacy PaymentType enum on RegistryRequest. The canonical source of truth
-- for "does this registry entry advertise payment metadata, and which kinds" is now the
-- SupportedPaymentSource child table introduced in the previous migration. The column
-- is write-only at this point (no readers) so the drop is safe.
ALTER TABLE "RegistryRequest" DROP COLUMN "paymentType";

DROP TYPE "PaymentType";
