-- Database-enforced settlement claim. This protects against concurrent service
-- replicas and rolling deployments where an older process does not yet acquire
-- the application advisory lock. Failed and Replayed attempts are excluded so a
-- definitive failure can be retried while successful/ambiguous attempts remain
-- permanently deduplicated.
CREATE UNIQUE INDEX "X402PaymentAttempt_active_settlement_payload_key"
ON "X402PaymentAttempt" ("paymentPayloadHash")
WHERE "paymentPayloadHash" IS NOT NULL
  AND "direction" = 'InboundSettle'
  AND "status" IN ('Verified', 'Settled');
