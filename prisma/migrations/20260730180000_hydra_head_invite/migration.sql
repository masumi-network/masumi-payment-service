-- Hydra: head invites replace the wire offer exchange (ADR 0011).
--
-- An Offer travelled between two parties who already knew each other, and was
-- delivered to the payment service — which forced operators to expose it. An
-- Invite carries the issuer's complete signed material, is handed over out of
-- band or POSTed to a Host, and is redeemed on the Host's Exchange Plane. The
-- payment service needs no inbound reachability at all.
--
-- Safe as a hard cut: the whole Hydra feature is unreleased, and no deployment
-- holds offer rows.

DROP TABLE IF EXISTS "HydraHeadOffer";
DROP TYPE IF EXISTS "HydraOfferStatus";
DROP TYPE IF EXISTS "HydraOfferRole";

CREATE TYPE "HydraInviteRole" AS ENUM ('Issuer', 'Redeemer');

CREATE TYPE "HydraInviteStatus" AS ENUM (
    'Issued',
    'Redeemed',
    'Started',
    'Completed',
    'Expired',
    'Revoked'
);

CREATE TABLE "HydraHeadInvite" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "network" "Network" NOT NULL,
    "role" "HydraInviteRole" NOT NULL,
    "status" "HydraInviteStatus" NOT NULL DEFAULT 'Issued',
    "nonce" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "localHotWalletId" TEXT NOT NULL,
    "hydraHostId" TEXT NOT NULL,
    "hostNodeId" TEXT NOT NULL,
    "issuerWalletAddress" TEXT NOT NULL,
    "issuerHydraVerificationKey" TEXT NOT NULL,
    "issuerCardanoVerificationKey" TEXT NOT NULL,
    "issuerAdvertise" TEXT NOT NULL,
    "issuerExchangeUrl" TEXT NOT NULL,
    "issuerSignature" TEXT NOT NULL,
    "issuerSignerKey" TEXT NOT NULL,
    "redeemedAt" TIMESTAMP(3),
    "redeemerWalletAddress" TEXT,
    "redeemerHydraVerificationKey" TEXT,
    "redeemerCardanoVerificationKey" TEXT,
    "redeemerAdvertise" TEXT,
    "redeemerExchangeUrl" TEXT,
    "redeemerSignature" TEXT,
    "redeemerSignerKey" TEXT,
    "contestationPeriodSeconds" INTEGER NOT NULL,
    "depositPeriodSeconds" INTEGER NOT NULL,
    "unsyncedPeriodSeconds" INTEGER NOT NULL,
    "ledgerParamsHash" TEXT,
    "hydraHeadId" TEXT,

    CONSTRAINT "HydraHeadInvite_pkey" PRIMARY KEY ("id")
);

-- The nonce is what makes an invite single-use, so uniqueness is the mechanism
-- rather than a convenience: two rows sharing one would both be redeemable.
CREATE UNIQUE INDEX "HydraHeadInvite_nonce_key" ON "HydraHeadInvite" ("nonce");

CREATE UNIQUE INDEX "HydraHeadInvite_hydraHeadId_key" ON "HydraHeadInvite" ("hydraHeadId");

-- Reaping unredeemed reservations; a node and a peer port sit idle until then.
CREATE INDEX "HydraHeadInvite_status_expiresAt_idx" ON "HydraHeadInvite" ("status", "expiresAt");

-- The redemption poll asks one Host what has changed.
CREATE INDEX "HydraHeadInvite_hydraHostId_status_idx" ON "HydraHeadInvite" ("hydraHostId", "status");

-- One live reservation per node. A second invite pointing at the same node
-- would have two exchanges racing to configure one process, and only one could
-- win — the loser having already told a counterparty it was ready.
CREATE UNIQUE INDEX "HydraHeadInvite_one_live_per_node_key"
    ON "HydraHeadInvite" ("hydraHostId", "hostNodeId")
    WHERE "status" IN ('Issued', 'Redeemed', 'Started');

ALTER TABLE "HydraHeadInvite"
    ADD CONSTRAINT "HydraHeadInvite_localHotWalletId_fkey"
    FOREIGN KEY ("localHotWalletId") REFERENCES "HotWallet" ("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "HydraHeadInvite"
    ADD CONSTRAINT "HydraHeadInvite_hydraHostId_fkey"
    FOREIGN KEY ("hydraHostId") REFERENCES "HydraHost" ("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "HydraHeadInvite"
    ADD CONSTRAINT "HydraHeadInvite_hydraHeadId_fkey"
    FOREIGN KEY ("hydraHeadId") REFERENCES "HydraHead" ("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
