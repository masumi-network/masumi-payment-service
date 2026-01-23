-- Migration: Add permission flags to ApiKey model
-- This migration converts the legacy permission enum to flag-based permissions and removes the enum

-- Step 1: Add new boolean columns with safe defaults
ALTER TABLE "ApiKey" ADD COLUMN "canRead" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "ApiKey" ADD COLUMN "canPay" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "ApiKey" ADD COLUMN "canAdmin" BOOLEAN NOT NULL DEFAULT false;

-- Step 2: Populate flags from existing permission enum
-- Mapping:
--   Read      -> canRead=true,  canPay=false, canAdmin=false
--   ReadAndPay -> canRead=true,  canPay=true,  canAdmin=false
--   Admin     -> canRead=true,  canPay=true,  canAdmin=true
UPDATE "ApiKey" SET 
  "canRead" = true,
  "canPay" = CASE WHEN "permission" IN ('ReadAndPay', 'Admin') THEN true ELSE false END,
  "canAdmin" = CASE WHEN "permission" = 'Admin' THEN true ELSE false END;

-- Step 3: Drop the legacy permission column (data has been converted to flags)
ALTER TABLE "ApiKey" DROP COLUMN "permission";

-- Step 4: Drop the Permission enum type (no longer needed)
DROP TYPE "Permission";
