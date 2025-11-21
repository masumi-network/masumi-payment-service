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

    // 2. Save current action to history
    await tx.paymentActionHistory.create({
      data: {
        paymentRequestId: paymentRequestId,
        requestedAction: current.NextAction.requestedAction,
      },
    });

    // 3. Handle error note concatenation
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

    // 4. Update to new NextAction (Prisma will handle delete + create via unique constraint)
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
    // Get current state
    const current = await tx.paymentRequest.findUnique({
      where: { id: paymentRequestId },
      select: {
        NextAction: {
          select: { requestedAction: true },
        },
      },
    });

    if (!current?.NextAction) {
      throw new Error(
        `PaymentRequest ${paymentRequestId} or its NextAction not found`,
      );
    }

    // Save history and update in one operation
    await tx.paymentRequest.update({
      where: { id: paymentRequestId },
      data: {
        ActionHistory: {
          create: {
            requestedAction: current.NextAction.requestedAction,
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
      await tx.paymentActionHistory.create({
        data: {
          paymentRequestId: paymentRequestId,
          requestedAction: current.NextAction.requestedAction,
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

    // 2. Save to history
    await tx.purchaseActionHistory.create({
      data: {
        purchaseRequestId: purchaseRequestId,
        requestedAction: current.NextAction.requestedAction,
      },
    });

    // 3. Handle error note concatenation
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

    // 4. Update to new NextAction
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
    // Get current state
    const current = await tx.purchaseRequest.findUnique({
      where: { id: purchaseRequestId },
      select: {
        NextAction: {
          select: { requestedAction: true },
        },
      },
    });

    if (!current?.NextAction) {
      throw new Error(
        `PurchaseRequest ${purchaseRequestId} or its NextAction not found`,
      );
    }

    // Save history and update in one operation
    await tx.purchaseRequest.update({
      where: { id: purchaseRequestId },
      data: {
        ActionHistory: {
          create: {
            requestedAction: current.NextAction.requestedAction,
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
      await tx.purchaseActionHistory.create({
        data: {
          purchaseRequestId: purchaseRequestId,
          requestedAction: current.NextAction.requestedAction,
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
