ALTER TABLE "WebhookEndpoint"
ADD COLUMN "urlHash" TEXT;

CREATE INDEX "WebhookEndpoint_urlHash_paymentSourceId_format_idx"
ON "WebhookEndpoint"("urlHash", "paymentSourceId", "format");
