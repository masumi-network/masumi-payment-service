-- Cross-instance settle serialization lock for x402 self-hosted facilitators.
--
-- Held on the wallet row itself (the x402 analogue of Cardano's HotWallet.lockedAt) — NOT a
-- separate lock table. A self-hosted facilitator broadcasts each settle as a tx from a single EVM
-- account, so its account nonce is a shared resource; this column serializes concurrent settles
-- per facilitator wallet across processes. Set while a settle is in flight, cleared on completion;
-- a stale lock (crashed holder) is stolen after the application's stale timeout.

ALTER TABLE "X402EvmWallet" ADD COLUMN "lockedAt" TIMESTAMP(3);
