
ALTER TABLE "Transaction" 
ADD COLUMN IF NOT EXISTS "fees" BIGINT,
ADD COLUMN IF NOT EXISTS "blockHeight" INTEGER,
ADD COLUMN IF NOT EXISTS "blockTime" INTEGER,
ADD COLUMN IF NOT EXISTS "outputAmount" TEXT,
ADD COLUMN IF NOT EXISTS "utxoCount" INTEGER,
ADD COLUMN IF NOT EXISTS "withdrawalCount" INTEGER,
ADD COLUMN IF NOT EXISTS "assetMintOrBurnCount" INTEGER,
ADD COLUMN IF NOT EXISTS "redeemerCount" INTEGER,
ADD COLUMN IF NOT EXISTS "validContract" BOOLEAN;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'Transaction' 
    AND column_name = 'fees' 
    AND data_type = 'text'
  ) THEN
    ALTER TABLE "Transaction" ALTER COLUMN "fees" TYPE BIGINT USING (
      CASE 
        WHEN "fees" IS NULL THEN NULL
        ELSE "fees"::BIGINT
      END
    );
  END IF;
END $$;

