
-- Step 1: Add WalletScoped enum value
DO $$ 
BEGIN
    IF EXISTS (SELECT 1 FROM pg_type WHERE typname = 'Permission') THEN
        IF NOT EXISTS (
            SELECT 1 FROM pg_enum 
            WHERE enumlabel = 'WalletScoped' 
            AND enumtypid = (SELECT oid FROM pg_type WHERE typname = 'Permission')
        ) THEN
            ALTER TYPE "Permission" ADD VALUE 'WalletScoped';
        END IF;
    END IF;
END $$;

-- Step 2: Add walletScopedApiKeyId column to HotWallet
DO $$
BEGIN
    -- Only add column if HotWallet table exists
    IF EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'HotWallet'
    ) THEN
        IF NOT EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_schema = 'public'
            AND table_name = 'HotWallet'
            AND column_name = 'walletScopedApiKeyId'
        ) THEN
            ALTER TABLE "HotWallet" ADD COLUMN "walletScopedApiKeyId" TEXT;
        END IF;
    END IF;
END $$;

-- Step 3: Migrate existing data from ApiKeyHotWallet (if it exists from previous version)
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'ApiKeyHotWallet'
    ) THEN
        UPDATE "HotWallet" h
        SET "walletScopedApiKeyId" = (
            SELECT akh."apiKeyId"
            FROM "ApiKeyHotWallet" akh
            WHERE akh."hotWalletId" = h.id
            ORDER BY akh."createdAt" ASC
            LIMIT 1
        )
        WHERE EXISTS (
            SELECT 1 FROM "ApiKeyHotWallet" akh2
            WHERE akh2."hotWalletId" = h.id
        )
        AND h."walletScopedApiKeyId" IS NULL;
    END IF;
END $$;

-- Step 4: Add foreign key constraint
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'HotWallet'
    ) AND EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'ApiKey'
    ) THEN
        IF NOT EXISTS (
            SELECT 1 FROM information_schema.table_constraints
            WHERE constraint_name = 'HotWallet_walletScopedApiKeyId_fkey'
            AND table_name = 'HotWallet'
        ) THEN
            ALTER TABLE "HotWallet" ADD CONSTRAINT "HotWallet_walletScopedApiKeyId_fkey" 
                FOREIGN KEY ("walletScopedApiKeyId") REFERENCES "ApiKey"("id") 
                ON DELETE SET NULL ON UPDATE CASCADE;
        END IF;
    END IF;
END $$;

-- Step 5: Add index for performance
DO $$
BEGIN
    -- Only add index if HotWallet table exists
    IF EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'HotWallet'
    ) THEN
        IF NOT EXISTS (
            SELECT 1 FROM pg_indexes
            WHERE schemaname = 'public'
            AND tablename = 'HotWallet'
            AND indexname = 'HotWallet_walletScopedApiKeyId_idx'
        ) THEN
            CREATE INDEX "HotWallet_walletScopedApiKeyId_idx" ON "HotWallet"("walletScopedApiKeyId");
        END IF;
    END IF;
END $$;

-- Step 6: Drop old join table (if it exists from previous version)
DROP TABLE IF EXISTS "ApiKeyHotWallet";

