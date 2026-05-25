-- H5: composite index for the hot path that filters active PaymentSources by
-- their dispatch type. The V1/V2 sync workers, registry-routing layer, and
-- admin "list active sources" all match on (paymentSourceType, deletedAt IS NULL),
-- so a covering index keeps these lookups out of full table scans as the
-- PaymentSource table grows beyond a handful of rows.
CREATE INDEX IF NOT EXISTS "PaymentSource_paymentSourceType_deletedAt_idx"
ON "PaymentSource"("paymentSourceType", "deletedAt");

-- M2: enforce the V1/V2 invariant for requiredAdminSignatures at the DB layer.
--   * Web3CardanoV1 sources MUST NOT carry a signature threshold (the V1
--     contract is a single-admin multisig wallet model and the column is
--     ignored).
--   * Web3CardanoV2 sources MUST carry a threshold >= 1, matching the V2
--     contract's M-of-N admin authority requirement. M=1 is a valid 1-of-N
--     pattern (any one of N admins can sign); stricter policies (e.g. require
--     >=2) are enforced at the domain layer where the deployment context is
--     known. The DB constraint ensures the threshold is at least nominally
--     positive so the validator's `M <= countOfAdmins` check is meaningful.
-- Prisma does not model CHECK constraints natively, so the schema.prisma field
-- carries a doc comment pointing back at this migration.
ALTER TABLE "PaymentSource"
ADD CONSTRAINT "PaymentSource_requiredAdminSignatures_check"
CHECK (
    ("paymentSourceType" = 'Web3CardanoV1' AND "requiredAdminSignatures" IS NULL)
    OR ("paymentSourceType" = 'Web3CardanoV2' AND "requiredAdminSignatures" IS NOT NULL AND "requiredAdminSignatures" >= 1)
);
