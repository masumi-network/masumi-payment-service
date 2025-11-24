import { prisma } from '@/utils/db';
import {
  PaymentAction,
  PurchasingAction,
  PaymentErrorType,
  PurchaseErrorType,
  Prisma,
} from '@prisma/client';

function isTransactionClient(client: any): client is Prisma.TransactionClient {
  if (client === prisma) {
    return false;
  }
  return true;
}

export async function updatePaymentNextAction(
  paymentRequestId: string,
  newAction: PaymentAction,
  options: {
    resultHash?: string | null;
    errorNote?: string | null;
    errorType?: PaymentErrorType | null;
    concatenateErrorNote?: boolean;
  } = {},
  prismaClient: Prisma.TransactionClient | typeof prisma = prisma,
) {
  const execute = async (tx: Prisma.TransactionClient) => {
    // 1. Get current state
    const current = await tx.paymentRequest.findUnique({
      where: { id: paymentRequestId },
      select: {
        NextAction: {
          select: {
            requestedAction: true,
            errorNote: true,
          },
        },
      },
    });

    if (!current) {
      throw new Error(`PaymentRequest ${paymentRequestId} not found`);
    }

    if (!current.NextAction) {
      throw new Error(
        'Cannot update NextAction that does not exist. Use direct create for initial setup.',
      );
    }

    const completeRecord = await tx.paymentRequest.findUnique({
      where: { id: paymentRequestId },
      include: { NextAction: true },
    });

    if (!completeRecord) {
      throw new Error(
        `PaymentRequest ${paymentRequestId} not found for history snapshot`,
      );
    }

    // 3. Save complete snapshot to history
    await tx.paymentActionHistory.create({
      data: {
        paymentRequestId: paymentRequestId,
        requestedAction: completeRecord.NextAction.requestedAction,
        snapshotCreatedAt: completeRecord.createdAt,
        snapshotUpdatedAt: completeRecord.updatedAt,
        lastCheckedAt: completeRecord.lastCheckedAt,
        paymentSourceId: completeRecord.paymentSourceId,
        smartContractWalletId: completeRecord.smartContractWalletId,
        buyerWalletId: completeRecord.buyerWalletId,
        nextActionId: completeRecord.nextActionId,
        requestedById: completeRecord.requestedById,
        currentTransactionId: completeRecord.currentTransactionId,
        metadata: completeRecord.metadata,
        blockchainIdentifier: completeRecord.blockchainIdentifier,
        submitResultTime: completeRecord.submitResultTime,
        unlockTime: completeRecord.unlockTime,
        externalDisputeUnlockTime: completeRecord.externalDisputeUnlockTime,
        inputHash: completeRecord.inputHash,
        resultHash: completeRecord.resultHash,
        onChainState: completeRecord.onChainState,
        sellerCoolDownTime: completeRecord.sellerCoolDownTime,
        buyerCoolDownTime: completeRecord.buyerCoolDownTime,
        collateralReturnLovelace: completeRecord.collateralReturnLovelace,
        payByTime: completeRecord.payByTime,
        nextActionResultHash: completeRecord.NextAction.resultHash,
        nextActionSubmittedTxHash: completeRecord.NextAction.submittedTxHash,
        nextActionErrorType: completeRecord.NextAction.errorType,
        nextActionErrorNote: completeRecord.NextAction.errorNote,
      },
    });

    // 4. Handle error note concatenation
    let finalErrorNote = options.errorNote;
    if (
      options.concatenateErrorNote &&
      current.NextAction.errorNote &&
      options.errorNote
    ) {
      finalErrorNote =
        current.NextAction.errorNote +
        '(' +
        current.NextAction.requestedAction +
        ')' +
        ' -> ' +
        options.errorNote;
    }

    // 5. Update to new NextAction (Prisma will handle delete + create via unique constraint)
    await tx.paymentRequest.update({
      where: { id: paymentRequestId },
      data: {
        NextAction: {
          create: {
            requestedAction: newAction,
            resultHash: options.resultHash,
            errorNote: finalErrorNote,
            errorType: options.errorType,
          },
        },
      },
    });
  };

  if (isTransactionClient(prismaClient)) {
    return await execute(prismaClient);
  }
  return await prisma.$transaction(execute);
}

export async function modifyPaymentNextAction(
  paymentRequestId: string,
  newAction: PaymentAction,
  options: {
    resultHash?: string | null;
  } = {},
  prismaClient: Prisma.TransactionClient | typeof prisma = prisma,
) {
  const execute = async (tx: Prisma.TransactionClient) => {
    // Fetch complete parent record INCLUDING NextAction for snapshot
    const completeRecord = await tx.paymentRequest.findUnique({
      where: { id: paymentRequestId },
      include: { NextAction: true },
    });

    if (!completeRecord?.NextAction) {
      throw new Error(
        `PaymentRequest ${paymentRequestId} or its NextAction not found`,
      );
    }

    // Update with complete history snapshot
    await tx.paymentRequest.update({
      where: { id: paymentRequestId },
      data: {
        ActionHistory: {
          create: {
            requestedAction: completeRecord.NextAction.requestedAction,
            snapshotCreatedAt: completeRecord.createdAt,
            snapshotUpdatedAt: completeRecord.updatedAt,
            lastCheckedAt: completeRecord.lastCheckedAt,
            paymentSourceId: completeRecord.paymentSourceId,
            smartContractWalletId: completeRecord.smartContractWalletId,
            buyerWalletId: completeRecord.buyerWalletId,
            nextActionId: completeRecord.nextActionId,
            requestedById: completeRecord.requestedById,
            currentTransactionId: completeRecord.currentTransactionId,
            metadata: completeRecord.metadata,
            blockchainIdentifier: completeRecord.blockchainIdentifier,
            submitResultTime: completeRecord.submitResultTime,
            unlockTime: completeRecord.unlockTime,
            externalDisputeUnlockTime: completeRecord.externalDisputeUnlockTime,
            inputHash: completeRecord.inputHash,
            resultHash: completeRecord.resultHash,
            onChainState: completeRecord.onChainState,
            sellerCoolDownTime: completeRecord.sellerCoolDownTime,
            buyerCoolDownTime: completeRecord.buyerCoolDownTime,
            collateralReturnLovelace: completeRecord.collateralReturnLovelace,
            payByTime: completeRecord.payByTime,
            nextActionResultHash: completeRecord.NextAction.resultHash,
            nextActionSubmittedTxHash:
              completeRecord.NextAction.submittedTxHash,
            nextActionErrorType: completeRecord.NextAction.errorType,
            nextActionErrorNote: completeRecord.NextAction.errorNote,
          },
        },
        NextAction: {
          update: {
            requestedAction: newAction,
            resultHash: options.resultHash,
          },
        },
      },
    });
  };

  if (isTransactionClient(prismaClient)) {
    return await execute(prismaClient);
  }
  return await prisma.$transaction(execute);
}

export async function upsertPaymentNextAction(
  paymentRequestId: string,
  newAction: PaymentAction,
  options: {
    errorNote?: string | null;
    errorType?: PaymentErrorType | null;
  } = {},
  prismaClient: Prisma.TransactionClient | typeof prisma = prisma,
) {
  const execute = async (tx: Prisma.TransactionClient) => {
    const current = await tx.paymentRequest.findUnique({
      where: { id: paymentRequestId },
      select: { NextAction: true },
    });

    if (!current) {
      throw new Error(`PaymentRequest ${paymentRequestId} not found`);
    }

    if (current.NextAction) {
      // Fetch complete parent record for snapshot
      const completeRecord = await tx.paymentRequest.findUnique({
        where: { id: paymentRequestId },
        include: { NextAction: true },
      });

      if (!completeRecord) {
        throw new Error(
          `PaymentRequest ${paymentRequestId} not found for history snapshot`,
        );
      }

      await tx.paymentActionHistory.create({
        data: {
          paymentRequestId: paymentRequestId,
          requestedAction: completeRecord.NextAction.requestedAction,
          snapshotCreatedAt: completeRecord.createdAt,
          snapshotUpdatedAt: completeRecord.updatedAt,
          lastCheckedAt: completeRecord.lastCheckedAt,
          paymentSourceId: completeRecord.paymentSourceId,
          smartContractWalletId: completeRecord.smartContractWalletId,
          buyerWalletId: completeRecord.buyerWalletId,
          nextActionId: completeRecord.nextActionId,
          requestedById: completeRecord.requestedById,
          currentTransactionId: completeRecord.currentTransactionId,
          metadata: completeRecord.metadata,
          blockchainIdentifier: completeRecord.blockchainIdentifier,
          submitResultTime: completeRecord.submitResultTime,
          unlockTime: completeRecord.unlockTime,
          externalDisputeUnlockTime: completeRecord.externalDisputeUnlockTime,
          inputHash: completeRecord.inputHash,
          resultHash: completeRecord.resultHash,
          onChainState: completeRecord.onChainState,
          sellerCoolDownTime: completeRecord.sellerCoolDownTime,
          buyerCoolDownTime: completeRecord.buyerCoolDownTime,
          collateralReturnLovelace: completeRecord.collateralReturnLovelace,
          payByTime: completeRecord.payByTime,
          nextActionResultHash: completeRecord.NextAction.resultHash,
          nextActionSubmittedTxHash: completeRecord.NextAction.submittedTxHash,
          nextActionErrorType: completeRecord.NextAction.errorType,
          nextActionErrorNote: completeRecord.NextAction.errorNote,
        },
      });
    }

    await tx.paymentRequest.update({
      where: { id: paymentRequestId },
      data: {
        NextAction: {
          upsert: {
            update: {
              requestedAction: newAction,
              errorNote: options.errorNote,
              errorType: options.errorType,
            },
            create: {
              requestedAction: newAction,
              errorNote: options.errorNote,
              errorType: options.errorType,
            },
          },
        },
      },
    });
  };

  if (isTransactionClient(prismaClient)) {
    return await execute(prismaClient);
  }
  return await prisma.$transaction(execute);
}

export async function updatePurchaseNextAction(
  purchaseRequestId: string,
  newAction: PurchasingAction,
  options: {
    inputHash: string;
    errorNote?: string | null;
    errorType?: PurchaseErrorType | null;
    concatenateErrorNote?: boolean;
  },
  prismaClient: Prisma.TransactionClient | typeof prisma = prisma,
) {
  const execute = async (tx: Prisma.TransactionClient) => {
    // 1. Get current state
    const current = await tx.purchaseRequest.findUnique({
      where: { id: purchaseRequestId },
      select: {
        NextAction: {
          select: {
            requestedAction: true,
            errorNote: true,
          },
        },
      },
    });

    if (!current?.NextAction) {
      throw new Error(
        `PurchaseRequest ${purchaseRequestId} or its NextAction not found`,
      );
    }

    // 2. Fetch complete parent record for snapshot
    const completeRecord = await tx.purchaseRequest.findUnique({
      where: { id: purchaseRequestId },
      include: { NextAction: true },
    });

    if (!completeRecord) {
      throw new Error(
        `PurchaseRequest ${purchaseRequestId} not found for history snapshot`,
      );
    }

    // 3. Save complete snapshot to history
    await tx.purchaseActionHistory.create({
      data: {
        purchaseRequestId: purchaseRequestId,
        requestedAction: completeRecord.NextAction.requestedAction,
        snapshotCreatedAt: completeRecord.createdAt,
        snapshotUpdatedAt: completeRecord.updatedAt,
        lastCheckedAt: completeRecord.lastCheckedAt,
        paymentSourceId: completeRecord.paymentSourceId,
        sellerWalletId: completeRecord.sellerWalletId,
        smartContractWalletId: completeRecord.smartContractWalletId,
        nextActionId: completeRecord.nextActionId,
        requestedById: completeRecord.requestedById,
        currentTransactionId: completeRecord.currentTransactionId,
        metadata: completeRecord.metadata,
        blockchainIdentifier: completeRecord.blockchainIdentifier,
        submitResultTime: completeRecord.submitResultTime,
        unlockTime: completeRecord.unlockTime,
        externalDisputeUnlockTime: completeRecord.externalDisputeUnlockTime,
        inputHash: completeRecord.inputHash,
        resultHash: completeRecord.resultHash,
        onChainState: completeRecord.onChainState,
        sellerCoolDownTime: completeRecord.sellerCoolDownTime,
        buyerCoolDownTime: completeRecord.buyerCoolDownTime,
        collateralReturnLovelace: completeRecord.collateralReturnLovelace,
        payByTime: completeRecord.payByTime,
        nextActionInputHash: completeRecord.NextAction.inputHash,
        nextActionSubmittedTxHash: completeRecord.NextAction.submittedTxHash,
        nextActionErrorType: completeRecord.NextAction.errorType,
        nextActionErrorNote: completeRecord.NextAction.errorNote,
      },
    });

    // 4. Handle error note concatenation
    let finalErrorNote = options.errorNote;
    if (
      options.concatenateErrorNote &&
      current.NextAction.errorNote &&
      options.errorNote
    ) {
      finalErrorNote =
        current.NextAction.errorNote +
        '(' +
        current.NextAction.requestedAction +
        ')' +
        ' -> ' +
        options.errorNote;
    }

    // 5. Update to new NextAction
    await tx.purchaseRequest.update({
      where: { id: purchaseRequestId },
      data: {
        NextAction: {
          create: {
            requestedAction: newAction,
            inputHash: options.inputHash,
            errorNote: finalErrorNote,
            errorType: options.errorType,
          },
        },
      },
    });
  };

  if (isTransactionClient(prismaClient)) {
    return await execute(prismaClient);
  }
  return await prisma.$transaction(execute);
}

export async function modifyPurchaseNextAction(
  purchaseRequestId: string,
  newAction: PurchasingAction,
  options: {
    inputHash: string;
  },
  prismaClient: Prisma.TransactionClient | typeof prisma = prisma,
) {
  const execute = async (tx: Prisma.TransactionClient) => {
    // Fetch complete parent record INCLUDING NextAction for snapshot
    const completeRecord = await tx.purchaseRequest.findUnique({
      where: { id: purchaseRequestId },
      include: { NextAction: true },
    });

    if (!completeRecord?.NextAction) {
      throw new Error(
        `PurchaseRequest ${purchaseRequestId} or its NextAction not found`,
      );
    }

    // Update with complete history snapshot
    await tx.purchaseRequest.update({
      where: { id: purchaseRequestId },
      data: {
        ActionHistory: {
          create: {
            requestedAction: completeRecord.NextAction.requestedAction,
            snapshotCreatedAt: completeRecord.createdAt,
            snapshotUpdatedAt: completeRecord.updatedAt,
            lastCheckedAt: completeRecord.lastCheckedAt,
            paymentSourceId: completeRecord.paymentSourceId,
            sellerWalletId: completeRecord.sellerWalletId,
            smartContractWalletId: completeRecord.smartContractWalletId,
            nextActionId: completeRecord.nextActionId,
            requestedById: completeRecord.requestedById,
            currentTransactionId: completeRecord.currentTransactionId,
            metadata: completeRecord.metadata,
            blockchainIdentifier: completeRecord.blockchainIdentifier,
            submitResultTime: completeRecord.submitResultTime,
            unlockTime: completeRecord.unlockTime,
            externalDisputeUnlockTime: completeRecord.externalDisputeUnlockTime,
            inputHash: completeRecord.inputHash,
            resultHash: completeRecord.resultHash,
            onChainState: completeRecord.onChainState,
            sellerCoolDownTime: completeRecord.sellerCoolDownTime,
            buyerCoolDownTime: completeRecord.buyerCoolDownTime,
            collateralReturnLovelace: completeRecord.collateralReturnLovelace,
            payByTime: completeRecord.payByTime,
            nextActionInputHash: completeRecord.NextAction.inputHash,
            nextActionSubmittedTxHash:
              completeRecord.NextAction.submittedTxHash,
            nextActionErrorType: completeRecord.NextAction.errorType,
            nextActionErrorNote: completeRecord.NextAction.errorNote,
          },
        },
        NextAction: {
          update: {
            requestedAction: newAction,
            inputHash: options.inputHash,
          },
        },
      },
    });
  };

  if (isTransactionClient(prismaClient)) {
    return await execute(prismaClient);
  }
  return await prisma.$transaction(execute);
}

export async function upsertPurchaseNextAction(
  purchaseRequestId: string,
  newAction: PurchasingAction,
  options: {
    inputHash: string;
    errorNote?: string | null;
    errorType?: PurchaseErrorType | null;
  },
  prismaClient: Prisma.TransactionClient | typeof prisma = prisma,
) {
  const execute = async (tx: Prisma.TransactionClient) => {
    const current = await tx.purchaseRequest.findUnique({
      where: { id: purchaseRequestId },
      select: {
        NextAction: true,
        inputHash: true,
      },
    });

    if (!current) {
      throw new Error(`PurchaseRequest ${purchaseRequestId} not found`);
    }

    // Only create history if NextAction exists
    if (current.NextAction) {
      // Fetch complete parent record for snapshot
      const completeRecord = await tx.purchaseRequest.findUnique({
        where: { id: purchaseRequestId },
        include: { NextAction: true },
      });

      if (!completeRecord) {
        throw new Error(
          `PurchaseRequest ${purchaseRequestId} not found for history snapshot`,
        );
      }

      await tx.purchaseActionHistory.create({
        data: {
          purchaseRequestId: purchaseRequestId,
          requestedAction: completeRecord.NextAction.requestedAction,
          snapshotCreatedAt: completeRecord.createdAt,
          snapshotUpdatedAt: completeRecord.updatedAt,
          lastCheckedAt: completeRecord.lastCheckedAt,
          paymentSourceId: completeRecord.paymentSourceId,
          sellerWalletId: completeRecord.sellerWalletId,
          smartContractWalletId: completeRecord.smartContractWalletId,
          nextActionId: completeRecord.nextActionId,
          requestedById: completeRecord.requestedById,
          currentTransactionId: completeRecord.currentTransactionId,
          metadata: completeRecord.metadata,
          blockchainIdentifier: completeRecord.blockchainIdentifier,
          submitResultTime: completeRecord.submitResultTime,
          unlockTime: completeRecord.unlockTime,
          externalDisputeUnlockTime: completeRecord.externalDisputeUnlockTime,
          inputHash: completeRecord.inputHash,
          resultHash: completeRecord.resultHash,
          onChainState: completeRecord.onChainState,
          sellerCoolDownTime: completeRecord.sellerCoolDownTime,
          buyerCoolDownTime: completeRecord.buyerCoolDownTime,
          collateralReturnLovelace: completeRecord.collateralReturnLovelace,
          payByTime: completeRecord.payByTime,
          nextActionInputHash: completeRecord.NextAction.inputHash,
          nextActionSubmittedTxHash: completeRecord.NextAction.submittedTxHash,
          nextActionErrorType: completeRecord.NextAction.errorType,
          nextActionErrorNote: completeRecord.NextAction.errorNote,
        },
      });
    }

    await tx.purchaseRequest.update({
      where: { id: purchaseRequestId },
      data: {
        NextAction: {
          upsert: {
            update: {
              requestedAction: newAction,
              inputHash: options.inputHash,
              errorNote: options.errorNote,
              errorType: options.errorType,
            },
            create: {
              requestedAction: newAction,
              inputHash: options.inputHash || current.inputHash,
              errorNote: options.errorNote,
              errorType: options.errorType,
            },
          },
        },
      },
    });
  };

  if (isTransactionClient(prismaClient)) {
    return await execute(prismaClient);
  }
  return await prisma.$transaction(execute);
}
