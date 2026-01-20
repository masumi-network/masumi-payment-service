import {
  PaymentAction,
  PurchasingAction,
  PaymentSource,
  OnChainState,
} from '@/generated/prisma/client';
import { prisma } from '@/utils/db';
import { logger } from '@/utils/logger';
import { CONFIG } from '@/utils/config';

import { Mutex, MutexInterface, tryAcquire } from 'async-mutex';

const mutex = new Mutex();

export async function handleAutomaticDecisions() {
  let release: MutexInterface.Releaser | null;
  try {
    release = await tryAcquire(mutex).acquire();
  } catch (e) {
    logger.info('Mutex timeout when locking', { error: e });
    return;
  }
  try {
    const paymentSources = await prisma.paymentSource.findMany({
      where: {
        syncInProgress: false,
        deletedAt: null,
      },
    });
    if (CONFIG.AUTO_WITHDRAW_PAYMENTS) {
      await handleInitializeAutoWithdrawPayments(paymentSources);
    }
    if (CONFIG.AUTO_WITHDRAW_REFUNDS) {
      await handleInitializeAutoWithdrawRefunds(paymentSources);
    }
  } catch (error) {
    logger.error(`Error updating wallet transaction hash`, { error: error });
  } finally {
    release();
  }
}

async function handleInitializeAutoWithdrawPayments(
  paymentSources: PaymentSource[],
) {
  await Promise.all(
    paymentSources.map(async (paymentSource) => {
      try {
        await prisma.$transaction(async (prisma) => {
          const paymentRequests = await prisma.paymentRequest.findMany({
            where: {
              paymentSourceId: paymentSource.id,
              NextAction: {
                requestedAction: PaymentAction.WaitingForExternalAction,
                errorType: null,
              },
              onChainState: {
                in: [OnChainState.ResultSubmitted],
              },
              resultHash: { not: null },
              unlockTime: {
                //10 minutes for blockchain time offset
                lte: Date.now() - 1000 * 60 * 10,
              },
            },
          });
          logger.info(
            `Found ${paymentRequests.length} auto withdraw payment requests for payment source ${paymentSource.id}`,
          );
          await Promise.all(
            paymentRequests.map(async (paymentRequest) => {
              try {
                await prisma.paymentRequest.update({
                  where: { id: paymentRequest.id },
                  data: {
                    ActionHistory: {
                      connect: {
                        id: paymentRequest.nextActionId,
                      },
                    },
                    NextAction: {
                      create: {
                        requestedAction: PaymentAction.WithdrawRequested,
                      },
                    },
                  },
                });
              } catch (error) {
                logger.error(`Error initializing auto withdraw payments`, {
                  paymentRequestId: paymentRequest.id,
                  error: error,
                });
              }
            }),
          );
        });
      } catch (error) {
        logger.error(`Error initializing auto withdraw payments`, {
          paymentSourceId: paymentSource.id,
          error: error,
        });
      }
    }),
  );
}

async function handleInitializeAutoWithdrawRefunds(
  paymentSources: PaymentSource[],
) {
  await Promise.all(
    paymentSources.map(async (paymentSource) => {
      try {
        await prisma.$transaction(async (prisma) => {
          const purchaseRequests = await prisma.purchaseRequest.findMany({
            where: {
              paymentSourceId: paymentSource.id,
              NextAction: {
                requestedAction: PurchasingAction.WaitingForExternalAction,
                errorType: null,
              },
              onChainState: {
                in: [OnChainState.RefundRequested, OnChainState.FundsLocked],
              },
              resultHash: null,
              submitResultTime: {
                //10 minutes for blockchain time offset
                lte: Date.now() - 1000 * 60 * 10,
              },
            },
          });
          logger.info(
            `Found ${purchaseRequests.length} auto withdraw refund requests for payment source ${paymentSource.id}`,
          );
          await Promise.all(
            purchaseRequests.map(async (purchaseRequest) => {
              try {
                await prisma.purchaseRequest.update({
                  where: { id: purchaseRequest.id },
                  data: {
                    ActionHistory: {
                      connect: {
                        id: purchaseRequest.nextActionId,
                      },
                    },
                    NextAction: {
                      create: {
                        requestedAction:
                          PurchasingAction.WithdrawRefundRequested,
                      },
                    },
                  },
                });
              } catch (error) {
                logger.error(`Error initializing auto withdraw refunds`, {
                  purchaseRequestId: purchaseRequest.id,
                  error: error,
                });
              }
            }),
          );
        });
      } catch (error) {
        logger.error(`Error initializing auto withdraw refunds`, {
          paymentSourceId: paymentSource.id,
          error: error,
        });
      }
    }),
  );
}
