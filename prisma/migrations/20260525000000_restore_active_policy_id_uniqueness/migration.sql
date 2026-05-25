-- Enforce deterministic PaymentSource resolution by registry policy id.
--
-- Soft-deleted sources may keep their historical policyId so audit/history rows
-- remain intact, but two active sources on the same network must not advertise
-- the same policyId. Prisma cannot model partial unique indexes, so this
-- invariant is maintained as a manual SQL migration and documented on the
-- PaymentSource model.
CREATE UNIQUE INDEX IF NOT EXISTS "PaymentSource_network_policyId_active_key"
ON "PaymentSource"("network", "policyId")
WHERE "deletedAt" IS NULL AND "policyId" IS NOT NULL;
