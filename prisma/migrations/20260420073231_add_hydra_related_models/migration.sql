-- CreateEnum
CREATE TYPE "TransactionLayer" AS ENUM ('L1', 'L2');

-- CreateEnum
CREATE TYPE "HydraHeadStatus" AS ENUM ('Disconnected', 'Connected', 'Connecting', 'Idle', 'Initializing', 'Open', 'Closed', 'FanoutPossible', 'Final');

-- CreateEnum
CREATE TYPE "HydraErrorType" AS ENUM ('CommandFailed', 'PostTxOnChainFailed', 'TxInvalid', 'InvalidInput');

-- AlterTable
ALTER TABLE "PaymentRequest" ADD COLUMN     "layer" "TransactionLayer" NOT NULL DEFAULT 'L1';

-- AlterTable
ALTER TABLE "PurchaseRequest" ADD COLUMN     "layer" "TransactionLayer" NOT NULL DEFAULT 'L1';

-- AlterTable
ALTER TABLE "Transaction" ADD COLUMN     "hydraHeadId" TEXT,
ADD COLUMN     "layer" "TransactionLayer" NOT NULL DEFAULT 'L1';

-- CreateTable
CREATE TABLE "HydraRelation" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "network" "Network" NOT NULL,
    "localHotWalletId" TEXT NOT NULL,
    "remoteWalletId" TEXT NOT NULL,

    CONSTRAINT "HydraRelation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HydraHead" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "hydraRelationId" TEXT NOT NULL,
    "headIdentifier" TEXT,
    "status" "HydraHeadStatus" NOT NULL DEFAULT 'Idle',
    "contestationPeriod" BIGINT NOT NULL DEFAULT 86400,
    "openedAt" TIMESTAMP(3),
    "closedAt" TIMESTAMP(3),
    "finalizedAt" TIMESTAMP(3),
    "contestationDeadline" TIMESTAMP(3),
    "latestActivityAt" TIMESTAMP(3),
    "latestSnapshotNumber" BIGINT NOT NULL DEFAULT 0,
    "initTxHash" TEXT,
    "closeTxHash" TEXT,
    "fanoutTxHash" TEXT,
    "isEnabled" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "HydraHead_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HydraLocalParticipant" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "hydraHeadId" TEXT,
    "walletId" TEXT NOT NULL,
    "nodeUrl" TEXT NOT NULL,
    "nodeHttpUrl" TEXT NOT NULL,
    "hasCommitted" BOOLEAN NOT NULL DEFAULT false,
    "commitTxHash" TEXT,
    "hydraSecretKeyId" TEXT NOT NULL,

    CONSTRAINT "HydraLocalParticipant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HydraRemoteParticipant" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "hydraHeadId" TEXT,
    "walletId" TEXT NOT NULL,
    "nodeUrl" TEXT NOT NULL,
    "nodeHttpUrl" TEXT NOT NULL,
    "hasCommitted" BOOLEAN NOT NULL DEFAULT false,
    "commitTxHash" TEXT,
    "hydraVerificationKeyId" TEXT NOT NULL,

    CONSTRAINT "HydraRemoteParticipant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HydraHeadError" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "hydraHeadId" TEXT NOT NULL,
    "errorType" "HydraErrorType" NOT NULL,
    "errorMessage" TEXT NOT NULL,
    "headStatus" "HydraHeadStatus" NOT NULL,
    "clientInput" TEXT,
    "txHash" TEXT,
    "errorAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "HydraHeadError_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HydraSecretKey" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "hydraSK" TEXT NOT NULL,

    CONSTRAINT "HydraSecretKey_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HydraVerificationKey" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "hydraVK" TEXT NOT NULL,

    CONSTRAINT "HydraVerificationKey_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "HydraRelation_network_idx" ON "HydraRelation"("network");

-- CreateIndex
CREATE INDEX "HydraRelation_localHotWalletId_idx" ON "HydraRelation"("localHotWalletId");

-- CreateIndex
CREATE UNIQUE INDEX "HydraRelation_network_localHotWalletId_remoteWalletId_key" ON "HydraRelation"("network", "localHotWalletId", "remoteWalletId");

-- CreateIndex
CREATE UNIQUE INDEX "HydraHead_headIdentifier_key" ON "HydraHead"("headIdentifier");

-- CreateIndex
CREATE INDEX "HydraHead_status_idx" ON "HydraHead"("status");

-- CreateIndex
CREATE INDEX "HydraHead_hydraRelationId_status_idx" ON "HydraHead"("hydraRelationId", "status");

-- CreateIndex
CREATE INDEX "HydraHead_hydraRelationId_status_isEnabled_idx" ON "HydraHead"("hydraRelationId", "status", "isEnabled");

-- CreateIndex
CREATE UNIQUE INDEX "HydraLocalParticipant_hydraHeadId_key" ON "HydraLocalParticipant"("hydraHeadId");

-- CreateIndex
CREATE UNIQUE INDEX "HydraLocalParticipant_hydraSecretKeyId_key" ON "HydraLocalParticipant"("hydraSecretKeyId");

-- CreateIndex
CREATE INDEX "HydraLocalParticipant_walletId_idx" ON "HydraLocalParticipant"("walletId");

-- CreateIndex
CREATE UNIQUE INDEX "HydraRemoteParticipant_hydraVerificationKeyId_key" ON "HydraRemoteParticipant"("hydraVerificationKeyId");

-- CreateIndex
CREATE INDEX "HydraRemoteParticipant_walletId_idx" ON "HydraRemoteParticipant"("walletId");

-- CreateIndex
CREATE UNIQUE INDEX "HydraRemoteParticipant_hydraHeadId_walletId_key" ON "HydraRemoteParticipant"("hydraHeadId", "walletId");

-- CreateIndex
CREATE INDEX "HydraHeadError_hydraHeadId_idx" ON "HydraHeadError"("hydraHeadId");

-- CreateIndex
CREATE INDEX "HydraHeadError_hydraHeadId_errorAt_idx" ON "HydraHeadError"("hydraHeadId", "errorAt");

-- CreateIndex
CREATE INDEX "PaymentRequest_layer_idx" ON "PaymentRequest"("layer");

-- CreateIndex
CREATE INDEX "PurchaseRequest_layer_idx" ON "PurchaseRequest"("layer");

-- CreateIndex
CREATE INDEX "Transaction_layer_idx" ON "Transaction"("layer");

-- CreateIndex
CREATE INDEX "Transaction_hydraHeadId_idx" ON "Transaction"("hydraHeadId");

-- AddForeignKey
ALTER TABLE "Transaction" ADD CONSTRAINT "Transaction_hydraHeadId_fkey" FOREIGN KEY ("hydraHeadId") REFERENCES "HydraHead"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HydraRelation" ADD CONSTRAINT "HydraRelation_localHotWalletId_fkey" FOREIGN KEY ("localHotWalletId") REFERENCES "HotWallet"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HydraRelation" ADD CONSTRAINT "HydraRelation_remoteWalletId_fkey" FOREIGN KEY ("remoteWalletId") REFERENCES "WalletBase"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HydraHead" ADD CONSTRAINT "HydraHead_hydraRelationId_fkey" FOREIGN KEY ("hydraRelationId") REFERENCES "HydraRelation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HydraLocalParticipant" ADD CONSTRAINT "HydraLocalParticipant_hydraHeadId_fkey" FOREIGN KEY ("hydraHeadId") REFERENCES "HydraHead"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HydraLocalParticipant" ADD CONSTRAINT "HydraLocalParticipant_walletId_fkey" FOREIGN KEY ("walletId") REFERENCES "HotWallet"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HydraLocalParticipant" ADD CONSTRAINT "HydraLocalParticipant_hydraSecretKeyId_fkey" FOREIGN KEY ("hydraSecretKeyId") REFERENCES "HydraSecretKey"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HydraRemoteParticipant" ADD CONSTRAINT "HydraRemoteParticipant_hydraHeadId_fkey" FOREIGN KEY ("hydraHeadId") REFERENCES "HydraHead"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HydraRemoteParticipant" ADD CONSTRAINT "HydraRemoteParticipant_walletId_fkey" FOREIGN KEY ("walletId") REFERENCES "WalletBase"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HydraRemoteParticipant" ADD CONSTRAINT "HydraRemoteParticipant_hydraVerificationKeyId_fkey" FOREIGN KEY ("hydraVerificationKeyId") REFERENCES "HydraVerificationKey"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HydraHeadError" ADD CONSTRAINT "HydraHeadError_hydraHeadId_fkey" FOREIGN KEY ("hydraHeadId") REFERENCES "HydraHead"("id") ON DELETE CASCADE ON UPDATE CASCADE;
