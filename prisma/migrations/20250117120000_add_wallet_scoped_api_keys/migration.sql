-- AlterEnum
-- Check if Permission enum and WalletScoped value exist before altering
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

-- CreateTable
-- Create ApiKeyHotWallet join table if it doesn't exist
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.tables 
        WHERE table_schema = 'public' 
        AND table_name = 'ApiKeyHotWallet'
    ) THEN
        CREATE TABLE "ApiKeyHotWallet" (
            "id" TEXT NOT NULL,
            "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
            "apiKeyId" TEXT NOT NULL,
            "hotWalletId" TEXT NOT NULL,

            CONSTRAINT "ApiKeyHotWallet_pkey" PRIMARY KEY ("id")
        );

        CREATE INDEX "ApiKeyHotWallet_apiKeyId_idx" ON "ApiKeyHotWallet"("apiKeyId");
        CREATE INDEX "ApiKeyHotWallet_hotWalletId_idx" ON "ApiKeyHotWallet"("hotWalletId");
        CREATE UNIQUE INDEX "ApiKeyHotWallet_apiKeyId_hotWalletId_key" ON "ApiKeyHotWallet"("apiKeyId", "hotWalletId");

        -- Add foreign keys only if parent tables exist
        IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'ApiKey') THEN
            ALTER TABLE "ApiKeyHotWallet" ADD CONSTRAINT "ApiKeyHotWallet_apiKeyId_fkey" 
                FOREIGN KEY ("apiKeyId") REFERENCES "ApiKey"("id") ON DELETE CASCADE ON UPDATE CASCADE;
        END IF;

        IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'HotWallet') THEN
            ALTER TABLE "ApiKeyHotWallet" ADD CONSTRAINT "ApiKeyHotWallet_hotWalletId_fkey" 
                FOREIGN KEY ("hotWalletId") REFERENCES "HotWallet"("id") ON DELETE CASCADE ON UPDATE CASCADE;
        END IF;
    END IF;
END $$;

