-- CreateEnum
CREATE TYPE "TransactionLayer" AS ENUM ('L1', 'L2');

-- CreateEnum
CREATE TYPE "HydraHeadStatus" AS ENUM ('Idle', 'Initializing', 'Open', 'Closed', 'FanoutPossible', 'Final');

-- CreateEnum
CREATE TYPE "HydraErrorType" AS ENUM ('CommandFailed', 'PostTxOnChainFailed', 'TxInvalid', 'InvalidInput');

-- AlterTable
ALTER TABLE "Transaction" ADD COLUMN     "hydraHeadId" TEXT,
ADD COLUMN     "layer" "TransactionLayer" NOT NULL DEFAULT 'L1';

-- CreateTable
CREATE TABLE "HydraRelation" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "network" "Network" NOT NULL,
    "walletIdA" TEXT NOT NULL,
    "walletIdB" TEXT NOT NULL,

    CONSTRAINT "HydraRelation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HydraHead" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "hydraRelationId" TEXT NOT NULL,
    "headId" TEXT,
    "status" "HydraHeadStatus" NOT NULL DEFAULT 'Idle',
    "contestationPeriod" INTEGER NOT NULL DEFAULT 86400,
    "openedAt" TIMESTAMP(3),
    "closedAt" TIMESTAMP(3),
    "finalizedAt" TIMESTAMP(3),
    "contestationDeadline" TIMESTAMP(3),
    "latestActivityAt" TIMESTAMP(3),
    "latestSnapshotNumber" INTEGER NOT NULL DEFAULT 0,
    "initTxHash" TEXT,
    "closeTxHash" TEXT,
    "fanoutTxHash" TEXT,
    "isEnabled" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "HydraHead_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HydraParticipant" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "hydraHeadId" TEXT NOT NULL,
    "walletId" TEXT NOT NULL,
    "nodeUrl" TEXT NOT NULL,
    "nodeHttpUrl" TEXT NOT NULL,
    "hasCommitted" BOOLEAN NOT NULL DEFAULT false,
    "commitTxHash" TEXT,
    "hydraSecretId" TEXT,

    CONSTRAINT "HydraParticipant_pkey" PRIMARY KEY ("id")
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
CREATE TABLE "HydraSecret" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "hydraSK" TEXT NOT NULL,

    CONSTRAINT "HydraSecret_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "HydraRelation_walletIdA_walletIdB_idx" ON "HydraRelation"("walletIdA", "walletIdB");

-- CreateIndex
CREATE UNIQUE INDEX "HydraRelation_network_walletIdA_walletIdB_key" ON "HydraRelation"("network", "walletIdA", "walletIdB");

-- CreateIndex
CREATE UNIQUE INDEX "HydraHead_headId_key" ON "HydraHead"("headId");

-- CreateIndex
CREATE INDEX "HydraHead_status_idx" ON "HydraHead"("status");

-- CreateIndex
CREATE INDEX "HydraHead_hydraRelationId_status_idx" ON "HydraHead"("hydraRelationId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "HydraParticipant_hydraSecretId_key" ON "HydraParticipant"("hydraSecretId");

-- CreateIndex
CREATE INDEX "HydraParticipant_walletId_idx" ON "HydraParticipant"("walletId");

-- CreateIndex
CREATE INDEX "HydraParticipant_walletId_hydraHeadId_idx" ON "HydraParticipant"("walletId", "hydraHeadId");

-- CreateIndex
CREATE UNIQUE INDEX "HydraParticipant_hydraHeadId_walletId_key" ON "HydraParticipant"("hydraHeadId", "walletId");

-- CreateIndex
CREATE INDEX "HydraHeadError_hydraHeadId_idx" ON "HydraHeadError"("hydraHeadId");

-- CreateIndex
CREATE INDEX "HydraHeadError_hydraHeadId_errorAt_idx" ON "HydraHeadError"("hydraHeadId", "errorAt");

-- CreateIndex
CREATE INDEX "Transaction_layer_idx" ON "Transaction"("layer");

-- CreateIndex
CREATE INDEX "Transaction_hydraHeadId_idx" ON "Transaction"("hydraHeadId");

-- AddForeignKey
ALTER TABLE "Transaction" ADD CONSTRAINT "Transaction_hydraHeadId_fkey" FOREIGN KEY ("hydraHeadId") REFERENCES "HydraHead"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HydraRelation" ADD CONSTRAINT "HydraRelation_walletIdA_fkey" FOREIGN KEY ("walletIdA") REFERENCES "WalletBase"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HydraRelation" ADD CONSTRAINT "HydraRelation_walletIdB_fkey" FOREIGN KEY ("walletIdB") REFERENCES "WalletBase"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HydraHead" ADD CONSTRAINT "HydraHead_hydraRelationId_fkey" FOREIGN KEY ("hydraRelationId") REFERENCES "HydraRelation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HydraParticipant" ADD CONSTRAINT "HydraParticipant_hydraHeadId_fkey" FOREIGN KEY ("hydraHeadId") REFERENCES "HydraHead"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HydraParticipant" ADD CONSTRAINT "HydraParticipant_walletId_fkey" FOREIGN KEY ("walletId") REFERENCES "HotWallet"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HydraParticipant" ADD CONSTRAINT "HydraParticipant_hydraSecretId_fkey" FOREIGN KEY ("hydraSecretId") REFERENCES "HydraSecret"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HydraHeadError" ADD CONSTRAINT "HydraHeadError_hydraHeadId_fkey" FOREIGN KEY ("hydraHeadId") REFERENCES "HydraHead"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CheckConstraint
ALTER TABLE "HydraRelation" ADD CONSTRAINT "HydraRelation_wallet_order_check" CHECK ("walletIdA" < "walletIdB");
