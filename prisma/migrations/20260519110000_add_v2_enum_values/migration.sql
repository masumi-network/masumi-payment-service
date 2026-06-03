-- Add V2 contract state / purchasing action enum values.
--
-- This migration is split from `20260519120000_add_payment_source_type_v2_registry_metadata`
-- so that the `ALTER TYPE ... ADD VALUE` statements run in their own
-- transaction block. Postgres < 12 forbids `ALTER TYPE ... ADD VALUE`
-- inside a transaction block (Postgres 12+ relaxes the restriction); Prisma
-- runs each migration file in a single transaction, so mixing these with
-- other DDL/DML in one file made the migration unrunnable on PG 11. Keeping
-- the four ADD VALUE statements isolated here keeps the migration
-- compatible with the entire range of supported Postgres versions.
--
-- IMPORTANT: this migration MUST run BEFORE
-- `20260519120000_add_payment_source_type_v2_registry_metadata` because that
-- migration's CREATE TABLE / DO $$ blocks expect the surrounding schema to
-- be in a consistent state with these enum values present. Lexical ordering
-- on the prefix `20260519110000` < `20260519120000` ensures Prisma applies
-- them in the right order.

ALTER TYPE "OnChainState" ADD VALUE IF NOT EXISTS 'WithdrawAuthorized';
ALTER TYPE "OnChainState" ADD VALUE IF NOT EXISTS 'RefundAuthorized';

ALTER TYPE "PurchasingAction" ADD VALUE IF NOT EXISTS 'AuthorizeWithdrawalRequested';
ALTER TYPE "PurchasingAction" ADD VALUE IF NOT EXISTS 'AuthorizeWithdrawalInitiated';
