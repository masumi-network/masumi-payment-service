-- Add tenant-ownership column to RegistryRequest so the deregister route
-- (and any future mutate route) can enforce `requestedById == ctx.id ||
-- ctx.canAdmin`, matching the PaymentRequest / PurchaseRequest pattern.
--
-- Nullable: legacy rows created before this column existed have no
-- recoverable owner. Application logic treats NULL-owner rows as admin-only
-- (`requestedById !== ctx.id && !ctx.canAdmin` → 403 when ctx.id is non-null;
-- NULL-owner rows additionally require canAdmin to mutate).

ALTER TABLE "RegistryRequest"
ADD COLUMN IF NOT EXISTS "requestedById" TEXT;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'RegistryRequest_requestedById_fkey'
    ) THEN
        ALTER TABLE "RegistryRequest"
        ADD CONSTRAINT "RegistryRequest_requestedById_fkey"
        FOREIGN KEY ("requestedById") REFERENCES "ApiKey"("id")
        ON DELETE SET NULL ON UPDATE CASCADE;
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS "RegistryRequest_requestedById_idx"
ON "RegistryRequest" ("requestedById");
