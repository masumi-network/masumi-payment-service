-- CreateIndex: the x402 settle dedup + crash-window guards query
-- X402PaymentAttempt by paymentPayloadHash (with direction/status) on every
-- settle. Without this index those lookups scan the whole table, which grows
-- unbounded with attempt history.
CREATE INDEX "X402PaymentAttempt_paymentPayloadHash_idx" ON "X402PaymentAttempt"("paymentPayloadHash");
