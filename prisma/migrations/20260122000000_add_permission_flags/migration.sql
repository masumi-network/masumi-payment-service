-- Migration: Replace legacy permission enum with flag-based system on ApiKey model

-- Step 1: Add new boolean columns with temporary defaults (needed for NOT NULL on existing rows)
ALTER TABLE "ApiKey" ADD COLUMN "canRead" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "ApiKey" ADD COLUMN "canPay" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "ApiKey" ADD COLUMN "canAdmin" BOOLEAN NOT NULL DEFAULT false;

-- Step 2: Populate flags from existing permission enum
-- Mapping:
--   Read       -> canRead=true,  canPay=false, canAdmin=false
--   ReadAndPay -> canRead=true,  canPay=true,  canAdmin=false
--   Admin      -> canRead=true,  canPay=true,  canAdmin=true
UPDATE "ApiKey" SET
  "canRead" = true,
  "canPay" = CASE WHEN "permission" IN ('ReadAndPay', 'Admin') THEN true ELSE false END,
  "canAdmin" = CASE WHEN "permission" = 'Admin' THEN true ELSE false END;

-- Step 3: Remove temporary defaults — values must now be set explicitly in application code
ALTER TABLE "ApiKey" ALTER COLUMN "canRead" DROP DEFAULT;
ALTER TABLE "ApiKey" ALTER COLUMN "canPay" DROP DEFAULT;
ALTER TABLE "ApiKey" ALTER COLUMN "canAdmin" DROP DEFAULT;

-- Step 4: Drop the legacy permission column and enum
ALTER TABLE "ApiKey" DROP COLUMN "permission";

DROP TYPE "Permission";
