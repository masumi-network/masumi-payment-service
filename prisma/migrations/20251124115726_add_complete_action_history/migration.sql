-- CreateTable
CREATE TABLE "PaymentActionHistory" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "requestedAction" "PaymentAction" NOT NULL,
    "paymentRequestId" TEXT NOT NULL,
    "snapshotCreatedAt" TIMESTAMP(3),
    "snapshotUpdatedAt" TIMESTAMP(3),
    "lastCheckedAt" TIMESTAMP(3),
    "paymentSourceId" TEXT,
    "smartContractWalletId" TEXT,
    "buyerWalletId" TEXT,
    "nextActionId" TEXT,
    "requestedById" TEXT,
    "currentTransactionId" TEXT,
    "metadata" TEXT,
    "blockchainIdentifier" TEXT,
    "submitResultTime" BIGINT,
    "unlockTime" BIGINT,
    "externalDisputeUnlockTime" BIGINT,
    "inputHash" TEXT,
    "resultHash" TEXT,
    "onChainState" "OnChainState",
    "sellerCoolDownTime" BIGINT,
    "buyerCoolDownTime" BIGINT,
    "collateralReturnLovelace" BIGINT,
    "payByTime" BIGINT,
    "nextActionResultHash" TEXT,
    "nextActionSubmittedTxHash" TEXT,
    "nextActionErrorType" "PaymentErrorType",
    "nextActionErrorNote" TEXT,

    CONSTRAINT "PaymentActionHistory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PurchaseActionHistory" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "requestedAction" "PurchasingAction" NOT NULL,
    "purchaseRequestId" TEXT NOT NULL,
    "snapshotCreatedAt" TIMESTAMP(3),
    "snapshotUpdatedAt" TIMESTAMP(3),
    "lastCheckedAt" TIMESTAMP(3),
    "paymentSourceId" TEXT,
    "sellerWalletId" TEXT,
    "smartContractWalletId" TEXT,
    "nextActionId" TEXT,
    "requestedById" TEXT,
    "currentTransactionId" TEXT,
    "metadata" TEXT,
    "blockchainIdentifier" TEXT,
    "submitResultTime" BIGINT,
    "unlockTime" BIGINT,
    "externalDisputeUnlockTime" BIGINT,
    "inputHash" TEXT,
    "resultHash" TEXT,
    "onChainState" "OnChainState",
    "sellerCoolDownTime" BIGINT,
    "buyerCoolDownTime" BIGINT,
    "collateralReturnLovelace" BIGINT,
    "payByTime" BIGINT,
    "nextActionInputHash" TEXT,
    "nextActionSubmittedTxHash" TEXT,
    "nextActionErrorType" "PurchaseErrorType",
    "nextActionErrorNote" TEXT,

    CONSTRAINT "PurchaseActionHistory_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PaymentActionHistory_paymentRequestId_createdAt_idx" ON "PaymentActionHistory"("paymentRequestId", "createdAt");

-- CreateIndex
CREATE INDEX "PurchaseActionHistory_purchaseRequestId_createdAt_idx" ON "PurchaseActionHistory"("purchaseRequestId", "createdAt");

-- AddForeignKey
ALTER TABLE "PaymentActionHistory" ADD CONSTRAINT "PaymentActionHistory_paymentRequestId_fkey" FOREIGN KEY ("paymentRequestId") REFERENCES "PaymentRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurchaseActionHistory" ADD CONSTRAINT "PurchaseActionHistory_purchaseRequestId_fkey" FOREIGN KEY ("purchaseRequestId") REFERENCES "PurchaseRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;
