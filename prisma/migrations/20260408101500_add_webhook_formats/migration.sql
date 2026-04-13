CREATE TYPE "WebhookFormat" AS ENUM ('EXTENDED', 'SLACK', 'GOOGLE_CHAT', 'DISCORD');

ALTER TABLE "WebhookEndpoint"
ADD COLUMN "format" "WebhookFormat" NOT NULL DEFAULT 'EXTENDED',
ALTER COLUMN "authToken" DROP NOT NULL;

UPDATE "WebhookEndpoint"
SET "format" = 'EXTENDED'
WHERE "format" IS NULL;
