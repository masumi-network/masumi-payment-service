-- x402 payment-source / wallet-binding refactor.
--
-- Elevates X402Network to a first-class payment source that OWNS its wallets
-- (mirrors Cardano PaymentSource -> HotWallet). Binds each X402EvmWallet to one
-- network and shares its key via X402WalletSecret, so the same EVM keypair on N
-- chains becomes N wallet rows sharing one secret. Chain-scoping columns drop out
-- of the budget / low-balance / attempt / settlement tables because the network is
-- now implied structurally (attempt -> networkId FK; budget/rule -> wallet.networkId).
-- Adds X402CounterpartyWallet (the EVM analogue of WalletBase) and a facilitatorUrl
-- so a network can run a REMOTE facilitator with no owned wallet.
--
-- Ordering: (1) additive DDL, (2) data backfill incl. per-network wallet fan-out,
-- (3) enforce NOT NULL + swap indexes/constraints + drop legacy columns.
--
-- This is intentionally an atomic maintenance cutover, not a rolling expand/contract
-- migration: the final schema removes columns required by the old binary. Stop application
-- writers before deploy. The transaction makes every DDL/backfill step rollback together,
-- while the table locks prevent a surviving old writer from changing rows mid-backfill.

BEGIN;

SELECT pg_advisory_xact_lock(hashtextextended('masumi:x402-wallet-binding-migration', 0));

LOCK TABLE
  "X402Network",
  "X402EvmWallet",
  "X402WalletBudget",
  "X402EvmWalletLowBalanceRule",
  "X402PaymentAttempt",
  "X402Settlement"
IN SHARE ROW EXCLUSIVE MODE;

-- A legacy wallet was allowed to exist without any configured network. The new model
-- requires every wallet to belong to one. An unassociated wallet is fanned out to every
-- configured network below, preserving its old chain-agnostic semantics. With no configured
-- network there is no truthful binding, so fail before the first DDL.
DO $$
DECLARE
  invalid_rule_ids TEXT;
BEGIN
  IF EXISTS (SELECT 1 FROM "X402EvmWallet")
     AND NOT EXISTS (SELECT 1 FROM "X402Network") THEN
    RAISE EXCEPTION 'Cannot migrate managed EVM wallets: no X402 network exists'
      USING HINT = 'Configure at least one X402 network before rerunning this migration.';
  END IF;

  SELECT string_agg(r."id", ', ' ORDER BY r."id")
  INTO invalid_rule_ids
  FROM "X402EvmWalletLowBalanceRule" r
  LEFT JOIN "X402Network" n ON n."caip2Id" = r."caip2Network"
  WHERE n."id" IS NULL;

  IF invalid_rule_ids IS NOT NULL THEN
    RAISE EXCEPTION 'Cannot migrate x402 low-balance rules with unregistered networks: %', invalid_rule_ids
      USING HINT = 'Register each rule caip2Network or remove the listed rules before rerunning this migration.';
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- (1) Additive: new enum, tables, and nullable staging columns
-- ---------------------------------------------------------------------------

CREATE TYPE "X402CounterpartyRole" AS ENUM ('Payee', 'Payer');
CREATE TYPE "X402FacilitatorMode" AS ENUM ('SelfHosted', 'Remote');

CREATE TABLE "X402WalletSecret" (
  "id" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "address" TEXT NOT NULL,
  "encryptedPrivateKey" TEXT NOT NULL,
  CONSTRAINT "X402WalletSecret_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "X402WalletSecret_address_key" ON "X402WalletSecret"("address");

CREATE TABLE "X402CounterpartyWallet" (
  "id" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "caip2Network" TEXT NOT NULL,
  "address" TEXT NOT NULL,
  "role" "X402CounterpartyRole" NOT NULL,
  "note" TEXT,
  CONSTRAINT "X402CounterpartyWallet_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "X402CounterpartyWallet_caip2Network_address_role_key"
  ON "X402CounterpartyWallet"("caip2Network", "address", "role");
CREATE INDEX "X402CounterpartyWallet_address_idx" ON "X402CounterpartyWallet"("address");

ALTER TABLE "X402Network"
  ADD COLUMN "facilitatorUrl" TEXT,
  ADD COLUMN "facilitatorAuthEnc" TEXT;
ALTER TABLE "X402Network"
  ADD CONSTRAINT "X402Network_facilitator_mode_check"
  CHECK ("facilitatorUrl" IS NULL OR "facilitatorWalletId" IS NULL);

ALTER TABLE "X402EvmWallet"
  ADD COLUMN "networkId" TEXT,
  ADD COLUMN "secretId" TEXT;

ALTER TABLE "X402PaymentAttempt"
  ADD COLUMN "networkId" TEXT,
  ADD COLUMN "facilitatorMode" "X402FacilitatorMode",
  ADD COLUMN "counterpartyWalletId" TEXT;

-- ---------------------------------------------------------------------------
-- (2) Backfill
-- ---------------------------------------------------------------------------

-- 2a. The legacy address was globally unique, so it is the stable public identity for
--     each encrypted key. Keeping it on the secret provides the database invariant that
--     concurrent cross-network imports of one EVM key converge on one secret row.
INSERT INTO "X402WalletSecret" ("id", "updatedAt", "address", "encryptedPrivateKey")
SELECT gen_random_uuid()::text, CURRENT_TIMESTAMP, w."address", w."encryptedPrivateKey"
FROM "X402EvmWallet" w;

UPDATE "X402EvmWallet" w
SET "secretId" = s."id"
FROM "X402WalletSecret" s
WHERE s."address" = w."address";

-- 2b. Attempt network is structural: map the legacy caip2Network string to the rail id.
--     Every attempt had a NOT NULL caip2Network FK'd to X402Network.caip2Id, so all map.
UPDATE "X402PaymentAttempt" a
SET "networkId" = n."id"
FROM "X402Network" n
WHERE n."caip2Id" = a."caip2Network";

-- 2c. Per-network wallet fan-out. A floating wallet touching K chains (via its budgets,
--     low-balance rules, outbound attempts, or facilitator role) becomes K wallet rows,
--     one per network, all sharing the secret. The original row keeps the first network;
--     each extra network gets a fresh row and its budgets/rules/attempts/facilitator link
--     are repointed to it. A wallet with no historical association is cloned to EVERY
--     configured network, preserving the unrestricted semantics of the legacy global wallet.
--     Drop the legacy global address uniqueness before cloning: the replacement uniqueness
--     is per-network and is created after the fan-out.
DROP INDEX "X402EvmWallet_address_key";

DO $$
DECLARE
  w RECORD;
  net RECORD;
  new_wallet_id TEXT;
  assigned BOOLEAN;
  has_associations BOOLEAN;
BEGIN
  FOR w IN SELECT * FROM "X402EvmWallet" ORDER BY "id" ASC LOOP
    assigned := FALSE;

    SELECT EXISTS (
      SELECT 1
      FROM "X402WalletBudget" b
      JOIN "X402Network" n ON n."caip2Id" = b."caip2Network"
      WHERE b."evmWalletId" = w."id"
      UNION ALL
      SELECT 1
      FROM "X402EvmWalletLowBalanceRule" r
      JOIN "X402Network" n ON n."caip2Id" = r."caip2Network"
      WHERE r."evmWalletId" = w."id"
      UNION ALL
      SELECT 1
      FROM "X402PaymentAttempt" a
      JOIN "X402Network" n ON n."caip2Id" = a."caip2Network"
      WHERE a."evmWalletId" = w."id"
      UNION ALL
      SELECT 1 FROM "X402Network" n WHERE n."facilitatorWalletId" = w."id"
    ) INTO has_associations;

    FOR net IN
      SELECT n."id" AS network_id, n."caip2Id" AS caip2
      FROM "X402Network" n
      WHERE NOT has_associations
         OR n."caip2Id" IN (
              SELECT b."caip2Network" FROM "X402WalletBudget" b WHERE b."evmWalletId" = w."id"
              UNION
              SELECT r."caip2Network" FROM "X402EvmWalletLowBalanceRule" r WHERE r."evmWalletId" = w."id"
              UNION
              SELECT a."caip2Network" FROM "X402PaymentAttempt" a WHERE a."evmWalletId" = w."id"
            )
         OR n."facilitatorWalletId" = w."id"
      ORDER BY n."id" ASC
    LOOP
      IF NOT assigned THEN
        UPDATE "X402EvmWallet" SET "networkId" = net.network_id WHERE "id" = w."id";
        assigned := TRUE;
      ELSE
        new_wallet_id := gen_random_uuid()::text;
        INSERT INTO "X402EvmWallet"
          ("id", "createdAt", "updatedAt", "networkId", "secretId", "address", "type", "encryptedPrivateKey", "note", "deletedAt", "createdById")
        VALUES
          (new_wallet_id, w."createdAt", CURRENT_TIMESTAMP, net.network_id, w."secretId", w."address", w."type", w."encryptedPrivateKey", w."note", w."deletedAt", w."createdById");

        UPDATE "X402WalletBudget"
          SET "evmWalletId" = new_wallet_id
          WHERE "evmWalletId" = w."id" AND "caip2Network" = net.caip2;
        UPDATE "X402EvmWalletLowBalanceRule"
          SET "evmWalletId" = new_wallet_id
          WHERE "evmWalletId" = w."id" AND "caip2Network" = net.caip2;
        UPDATE "X402PaymentAttempt"
          SET "evmWalletId" = new_wallet_id
          WHERE "evmWalletId" = w."id" AND "caip2Network" = net.caip2;
        UPDATE "X402Network"
          SET "facilitatorWalletId" = new_wallet_id
          WHERE "id" = net.network_id AND "facilitatorWalletId" = w."id";
      END IF;
    END LOOP;

    IF NOT assigned THEN
      RAISE EXCEPTION 'Cannot derive any network binding for legacy x402 wallet %', w."id"
        USING HINT = 'Register the referenced network or remove the wallet before rerunning this migration.';
    END IF;
  END LOOP;
END $$;

-- 2d. Do NOT infer a historical inbound attempt's facilitator from today's network
--     configuration. Legacy facilitatorMode remains NULL (reported as unknown), and its
--     evmWalletId remains unchanged. New application writes snapshot the actual mode.

-- 2e. Counterparty entities from the legacy loose strings.
--     Outbound -> payTo is the Payee; inbound -> payer is the Payer (when known).
--     Addresses are lowercased to match runtime upsertCounterpartyWalletId (normalizeAddress),
--     so a pre-migration counterparty and a post-migration one for the same on-chain party
--     dedupe to a single (caip2Network, address, role) row instead of splitting on case.
INSERT INTO "X402CounterpartyWallet" ("id", "updatedAt", "caip2Network", "address", "role")
SELECT gen_random_uuid()::text, CURRENT_TIMESTAMP, d."caip2Network", d."address", 'Payee'::"X402CounterpartyRole"
FROM (
  SELECT DISTINCT a."caip2Network", LOWER(a."payTo") AS "address"
  FROM "X402PaymentAttempt" a
  WHERE a."direction" = 'OutboundPayment' AND a."payTo" IS NOT NULL
) d
ON CONFLICT ("caip2Network", "address", "role") DO NOTHING;

INSERT INTO "X402CounterpartyWallet" ("id", "updatedAt", "caip2Network", "address", "role")
SELECT gen_random_uuid()::text, CURRENT_TIMESTAMP, d."caip2Network", d."address", 'Payer'::"X402CounterpartyRole"
FROM (
  SELECT DISTINCT a."caip2Network", LOWER(a."payer") AS "address"
  FROM "X402PaymentAttempt" a
  WHERE a."direction" IN ('InboundSettle', 'InboundVerify') AND a."payer" IS NOT NULL
) d
ON CONFLICT ("caip2Network", "address", "role") DO NOTHING;

UPDATE "X402PaymentAttempt" a
SET "counterpartyWalletId" = c."id"
FROM "X402CounterpartyWallet" c
WHERE a."direction" = 'OutboundPayment'
  AND c."role" = 'Payee'
  AND c."caip2Network" = a."caip2Network"
  AND c."address" = LOWER(a."payTo");

UPDATE "X402PaymentAttempt" a
SET "counterpartyWalletId" = c."id"
FROM "X402CounterpartyWallet" c
WHERE a."direction" IN ('InboundSettle', 'InboundVerify')
  AND a."payer" IS NOT NULL
  AND c."role" = 'Payer'
  AND c."caip2Network" = a."caip2Network"
  AND c."address" = LOWER(a."payer");

-- ---------------------------------------------------------------------------
-- (3) Enforce constraints, swap indexes, drop legacy columns
-- ---------------------------------------------------------------------------

-- Drop legacy FKs that reference X402Network.caip2Id or the SetNull wallet link.
ALTER TABLE "X402PaymentAttempt" DROP CONSTRAINT "X402PaymentAttempt_caip2Network_fkey";
ALTER TABLE "X402PaymentAttempt" DROP CONSTRAINT "X402PaymentAttempt_evmWalletId_fkey";
ALTER TABLE "X402WalletBudget" DROP CONSTRAINT "X402WalletBudget_caip2Network_fkey";

-- Drop legacy indexes tied to columns that are going away.
DROP INDEX "X402PaymentAttempt_caip2Network_asset_idx";
DROP INDEX "X402WalletBudget_apiKeyId_evmWalletId_caip2Network_asset_key";
DROP INDEX "X402WalletBudget_caip2Network_asset_idx";
DROP INDEX "X402EvmWalletLowBalanceRule_evmWalletId_caip2Network_asset_key";
DROP INDEX "X402Settlement_caip2Network_idx";

-- Wallet: enforce binding, drop the per-wallet key (now on the shared secret).
ALTER TABLE "X402EvmWallet"
  ALTER COLUMN "networkId" SET NOT NULL,
  ALTER COLUMN "secretId" SET NOT NULL,
  DROP COLUMN "encryptedPrivateKey";
CREATE UNIQUE INDEX "X402EvmWallet_networkId_address_key" ON "X402EvmWallet"("networkId", "address");
CREATE INDEX "X402EvmWallet_secretId_idx" ON "X402EvmWallet"("secretId");

-- Budget / low-balance: chain implied by the wallet; drop caip2Network.
ALTER TABLE "X402WalletBudget" DROP COLUMN "caip2Network";
CREATE UNIQUE INDEX "X402WalletBudget_apiKeyId_evmWalletId_asset_key"
  ON "X402WalletBudget"("apiKeyId", "evmWalletId", "asset");
CREATE INDEX "X402WalletBudget_evmWalletId_asset_idx" ON "X402WalletBudget"("evmWalletId", "asset");

ALTER TABLE "X402EvmWalletLowBalanceRule" DROP COLUMN "caip2Network";
CREATE UNIQUE INDEX "X402EvmWalletLowBalanceRule_evmWalletId_asset_key"
  ON "X402EvmWalletLowBalanceRule"("evmWalletId", "asset");

-- Attempt: network structural and counterparty linked. Retain payTo as an immutable
-- recipient snapshot: inbound attempts otherwise lose it when their registered source
-- is replaced and the source FK is set to NULL. New attempts may populate it directly.
ALTER TABLE "X402PaymentAttempt"
  ALTER COLUMN "networkId" SET NOT NULL,
  ALTER COLUMN "payTo" DROP NOT NULL,
  DROP COLUMN "caip2Network",
  DROP COLUMN "payer";
CREATE INDEX "X402PaymentAttempt_networkId_asset_idx" ON "X402PaymentAttempt"("networkId", "asset");
CREATE INDEX "X402PaymentAttempt_evmWalletId_idx" ON "X402PaymentAttempt"("evmWalletId");
CREATE INDEX "X402PaymentAttempt_counterpartyWalletId_idx" ON "X402PaymentAttempt"("counterpartyWalletId");

-- Settlement: network + payer derivable from the attempt; keep facilitator raw in rawResponse.
ALTER TABLE "X402Settlement"
  DROP COLUMN "caip2Network",
  DROP COLUMN "payer";

-- New foreign keys.
ALTER TABLE "X402EvmWallet"
  ADD CONSTRAINT "X402EvmWallet_networkId_fkey"
  FOREIGN KEY ("networkId") REFERENCES "X402Network"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "X402EvmWallet"
  ADD CONSTRAINT "X402EvmWallet_secretId_fkey"
  FOREIGN KEY ("secretId") REFERENCES "X402WalletSecret"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "X402PaymentAttempt"
  ADD CONSTRAINT "X402PaymentAttempt_networkId_fkey"
  FOREIGN KEY ("networkId") REFERENCES "X402Network"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "X402PaymentAttempt"
  ADD CONSTRAINT "X402PaymentAttempt_evmWalletId_fkey"
  FOREIGN KEY ("evmWalletId") REFERENCES "X402EvmWallet"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "X402PaymentAttempt"
  ADD CONSTRAINT "X402PaymentAttempt_counterpartyWalletId_fkey"
  FOREIGN KEY ("counterpartyWalletId") REFERENCES "X402CounterpartyWallet"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

COMMIT;
