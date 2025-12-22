-- AlterEnum
-- Only alter if Permission type exists (handles fresh databases)
DO $$ 
BEGIN
    -- Check if Permission type exists first
    IF EXISTS (SELECT 1 FROM pg_type WHERE typname = 'Permission') THEN
        -- Check if WalletScoped value already exists
        IF NOT EXISTS (
            SELECT 1 FROM pg_enum 
            WHERE enumlabel = 'WalletScoped' 
            AND enumtypid = (SELECT oid FROM pg_type WHERE typname = 'Permission')
        ) THEN
            ALTER TYPE "Permission" ADD VALUE 'WalletScoped';
        END IF;
    END IF;
END $$;

-- CreateTable (only if ApiKey and HotWallet tables exist)
DO $$ 
BEGIN
    -- Check if ApiKey and HotWallet tables exist before creating the join table
    IF EXISTS (
        SELECT 1 FROM information_schema.tables 
        WHERE table_schema = 'public' 
        AND table_name = 'ApiKey'
    ) AND EXISTS (
        SELECT 1 FROM information_schema.tables 
        WHERE table_schema = 'public' 
        AND table_name = 'HotWallet'
    ) AND NOT EXISTS (
        SELECT 1 FROM information_schema.tables 
        WHERE table_schema = 'public' 
        AND table_name = 'ApiKeyHotWallet'
    ) THEN
        -- CreateTable
        CREATE TABLE "ApiKeyHotWallet" (
            "id" TEXT NOT NULL,
            "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
            "apiKeyId" TEXT NOT NULL,
            "hotWalletId" TEXT NOT NULL,

            CONSTRAINT "ApiKeyHotWallet_pkey" PRIMARY KEY ("id")
        );

        -- CreateIndex
        CREATE INDEX "ApiKeyHotWallet_apiKeyId_idx" ON "ApiKeyHotWallet"("apiKeyId");

        -- CreateIndex
        CREATE INDEX "ApiKeyHotWallet_hotWalletId_idx" ON "ApiKeyHotWallet"("hotWalletId");

        -- CreateIndex
        CREATE UNIQUE INDEX "ApiKeyHotWallet_apiKeyId_hotWalletId_key" ON "ApiKeyHotWallet"("apiKeyId", "hotWalletId");

        -- AddForeignKey
        ALTER TABLE "ApiKeyHotWallet" ADD CONSTRAINT "ApiKeyHotWallet_apiKeyId_fkey" FOREIGN KEY ("apiKeyId") REFERENCES "ApiKey"("id") ON DELETE CASCADE ON UPDATE CASCADE;

        -- AddForeignKey
        ALTER TABLE "ApiKeyHotWallet" ADD CONSTRAINT "ApiKeyHotWallet_hotWalletId_fkey" FOREIGN KEY ("hotWalletId") REFERENCES "HotWallet"("id") ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END $$;

