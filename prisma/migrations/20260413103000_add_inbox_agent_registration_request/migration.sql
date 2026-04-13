CREATE TABLE "InboxAgentRegistrationRequest" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "lastCheckedAt" TIMESTAMP(3),
    "paymentSourceId" TEXT NOT NULL,
    "smartContractWalletId" TEXT NOT NULL,
    "recipientHotWalletId" TEXT,
    "deregistrationHotWalletId" TEXT,
    "sendFundingLovelace" BIGINT,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "agentSlug" TEXT NOT NULL,
    "metadataVersion" INTEGER NOT NULL,
    "agentIdentifier" TEXT,
    "state" "RegistrationState" NOT NULL,
    "registrationStateLastChangedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "currentTransactionId" TEXT,
    "error" TEXT,

    CONSTRAINT "InboxAgentRegistrationRequest_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "InboxAgentRegistrationRequest_agentIdentifier_key"
ON "InboxAgentRegistrationRequest"("agentIdentifier");

CREATE INDEX "InboxAgentRegistrationRequest_recipientHotWalletId_idx"
ON "InboxAgentRegistrationRequest"("recipientHotWalletId");

CREATE INDEX "InboxAgentRegistrationRequest_deregistrationHotWalletId_idx"
ON "InboxAgentRegistrationRequest"("deregistrationHotWalletId");

ALTER TABLE "InboxAgentRegistrationRequest"
ADD CONSTRAINT "InboxAgentRegistrationRequest_paymentSourceId_fkey"
FOREIGN KEY ("paymentSourceId") REFERENCES "PaymentSource"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "InboxAgentRegistrationRequest"
ADD CONSTRAINT "InboxAgentRegistrationRequest_smartContractWalletId_fkey"
FOREIGN KEY ("smartContractWalletId") REFERENCES "HotWallet"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "InboxAgentRegistrationRequest"
ADD CONSTRAINT "InboxAgentRegistrationRequest_recipientHotWalletId_fkey"
FOREIGN KEY ("recipientHotWalletId") REFERENCES "HotWallet"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "InboxAgentRegistrationRequest"
ADD CONSTRAINT "InboxAgentRegistrationRequest_deregistrationHotWalletId_fkey"
FOREIGN KEY ("deregistrationHotWalletId") REFERENCES "HotWallet"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "InboxAgentRegistrationRequest"
ADD CONSTRAINT "InboxAgentRegistrationRequest_currentTransactionId_fkey"
FOREIGN KEY ("currentTransactionId") REFERENCES "Transaction"("id") ON DELETE SET NULL ON UPDATE CASCADE;

DROP TRIGGER IF EXISTS "trg_InboxAgentRegistrationRequest_registrationStateLastChangedAt"
ON "InboxAgentRegistrationRequest";

DROP FUNCTION IF EXISTS "fn_InboxAgentRegistrationRequest_registrationStateLastChangedAt"();

CREATE FUNCTION "fn_InboxAgentRegistrationRequest_registrationStateLastChangedAt"()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW."state" IS DISTINCT FROM OLD."state" OR NEW."error" IS DISTINCT FROM OLD."error" THEN
    NEW."registrationStateLastChangedAt" = CURRENT_TIMESTAMP;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "trg_InboxAgentRegistrationRequest_registrationStateLastChangedAt"
BEFORE UPDATE ON "InboxAgentRegistrationRequest"
FOR EACH ROW
EXECUTE FUNCTION "fn_InboxAgentRegistrationRequest_registrationStateLastChangedAt"();
