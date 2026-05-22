-- V2 batch multi-redeemer txs need to reference a single Transaction row from
-- multiple PaymentRequest / PurchaseRequest rows. The @unique on
-- currentTransactionId was a leftover from the V1 single-item flow and blocked
-- the sharing. Existing rows are unaffected: until V2 batch services start
-- writing, every existing currentTransactionId remains de-facto unique.
DROP INDEX IF EXISTS "PaymentRequest_currentTransactionId_key";
DROP INDEX IF EXISTS "PurchaseRequest_currentTransactionId_key";
