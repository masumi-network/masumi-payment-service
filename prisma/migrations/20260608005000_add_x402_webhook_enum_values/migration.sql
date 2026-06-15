-- Add x402 webhook event types (settled / failed / low-balance) so the EVM rail can
-- notify receivers and operators through the shared webhook system.
--
-- This migration is split from `20260608010000_add_x402_low_balance_and_webhooks`
-- so that the `ALTER TYPE ... ADD VALUE` statements run in their own transaction
-- block. Postgres < 12 forbids `ALTER TYPE ... ADD VALUE` inside a transaction
-- block; Prisma runs each migration file in a single transaction, so mixing these
-- with the CREATE TABLE in one file would make it unrunnable on PG 11. Lexical
-- ordering (`20260608005000` < `20260608010000`) ensures Prisma applies the enum
-- additions before the table migration that follows.

ALTER TYPE "WebhookEventType" ADD VALUE IF NOT EXISTS 'X402_PAYMENT_SETTLED';
ALTER TYPE "WebhookEventType" ADD VALUE IF NOT EXISTS 'X402_PAYMENT_FAILED';
ALTER TYPE "WebhookEventType" ADD VALUE IF NOT EXISTS 'X402_WALLET_LOW_BALANCE';
