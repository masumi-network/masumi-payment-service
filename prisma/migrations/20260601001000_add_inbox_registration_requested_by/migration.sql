-- Add tenant-ownership column to InboxAgentRegistrationRequest so inbox
-- deregistration can enforce `requestedById == ctx.id || ctx.canAdmin`,
-- matching regular RegistryRequest behavior.
--
-- Nullable: legacy rows created before this column existed have no
-- recoverable owner. Application logic treats NULL-owner rows as admin-only.

ALTER TABLE "InboxAgentRegistrationRequest"
ADD COLUMN IF NOT EXISTS "requestedById" TEXT;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'InboxAgentRegistrationRequest_requestedById_fkey'
    ) THEN
        ALTER TABLE "InboxAgentRegistrationRequest"
        ADD CONSTRAINT "InboxAgentRegistrationRequest_requestedById_fkey"
        FOREIGN KEY ("requestedById") REFERENCES "ApiKey"("id")
        ON DELETE SET NULL ON UPDATE CASCADE;
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS "InboxAgentRegistrationRequest_requestedById_idx"
ON "InboxAgentRegistrationRequest" ("requestedById");
