import {
  HotWalletType,
  TransactionStatus,
  PaymentAction,
  PaymentErrorType,
  PurchasingAction,
  PurchaseErrorType,
  RegistrationState,
} from '@prisma/client';
import { prisma } from '@/utils/db';
import { BlockfrostProvider } from '@meshsdk/core';
import { logger } from '@/utils/logger';
import { collectRefundV1 } from '../cardano-refund-handler/';
import { submitResultV1 } from '../cardano-submit-result-handler/';
import { requestRefundsV1 } from '../cardano-request-refund-handler/';
import { collectOutstandingPaymentsV1 } from '../cardano-collection-handler/';
import { batchLatestPaymentEntriesV1 } from '../cardano-payment-batcher/';
import { registerAgentV1 } from '../cardano-register-handler/';
import { deRegisterAgentV1 } from '../cardano-deregister-handler/';
import { authorizeRefundV1 } from '../cardano-authorize-refund-handler/';
import { cancelRefundsV1 } from '../cardano-cancel-refund-handler/';
import { CONFIG, DEFAULTS } from '@/utils/config';
import { errorToString } from '@/utils/converter/error-string-convert';
import { Mutex, MutexInterface, tryAcquire } from 'async-mutex';

const mutex = new Mutex();

export async function updateWalletTransactionHash() {
  let release: MutexInterface.Releaser | null;
  try {
    release = await tryAcquire(mutex).acquire();
  } catch (e) {
    logger.info('Mutex timeout when locking', { error: e });
    return;
  }
  const unlockedSellingWalletIds: string[] = [];
  const unlockedPurchasingWalletIds: string[] = [];
  try {
    await prisma.$transaction(async (prisma) => {
      const result = await prisma.paymentRequest.findMany({
        where: {
          NextAction: {
            requestedAction: {
              in: [
                PaymentAction.WithdrawInitiated,
                PaymentAction.SubmitResultInitiated,
                PaymentAction.AuthorizeRefundInitiated,
              ],
            },
          },
          OR: [
            {
              updatedAt: {
                lt: new Date(
                  Date.now() -
                    //15 minutes for timeouts, check every tx older than 1 minute
                    CONFIG.WALLET_LOCK_TIMEOUT_INTERVAL,
                ),
              },
              CurrentTransaction: null,
            },
            {
              CurrentTransaction: {
                status: TransactionStatus.Pending,
                updatedAt: {
                  lt: new Date(
                    Date.now() -
                      //15 minutes for timeouts, check every tx older than 1 minute
                      DEFAULTS.TX_TIMEOUT_INTERVAL,
                  ),
                },
              },
            },
          ],
        },
        include: { SmartContractWallet: { where: { deletedAt: null } } },
      });
      for (const paymentRequest of result) {
        if (paymentRequest.currentTransactionId == null) {
          if (
            paymentRequest.SmartContractWallet != null &&
            paymentRequest.SmartContractWallet.pendingTransactionId == null &&
            paymentRequest.SmartContractWallet.lockedAt &&
            new Date(paymentRequest.SmartContractWallet.lockedAt) <
              new Date(Date.now() - CONFIG.WALLET_LOCK_TIMEOUT_INTERVAL)
          )
            unlockedSellingWalletIds.push(
              paymentRequest.SmartContractWallet?.id,
            );

          await prisma.paymentRequest.update({
            where: { id: paymentRequest.id },
            data: {
              SmartContractWallet:
                paymentRequest.SmartContractWallet == null
                  ? undefined
                  : {
                      update: {
                        //we expect there not to be a pending transaction. Otherwise we do not unlock the wallet
                        lockedAt:
                          paymentRequest.SmartContractWallet
                            .pendingTransactionId == null &&
                          paymentRequest.SmartContractWallet.lockedAt &&
                          new Date(
                            paymentRequest.SmartContractWallet.lockedAt,
                          ) <
                            new Date(
                              Date.now() - CONFIG.WALLET_LOCK_TIMEOUT_INTERVAL,
                            )
                            ? null
                            : undefined,
                      },
                    },
              ActionHistory: {
                connect: {
                  id: paymentRequest.nextActionId,
                },
              },
              NextAction: {
                create: {
                  requestedAction: PaymentAction.WaitingForExternalAction,
                  errorNote: 'Timeout when locking',
                  errorType: PaymentErrorType.Unknown,
                },
              },
            },
          });
        } else {
          if (
            (paymentRequest.SmartContractWallet?.pendingTransactionId != null &&
              paymentRequest.SmartContractWallet?.pendingTransactionId ==
                paymentRequest.currentTransactionId) ||
            (paymentRequest.SmartContractWallet?.lockedAt &&
              new Date(paymentRequest.SmartContractWallet.lockedAt) <
                new Date(Date.now() - DEFAULTS.TX_TIMEOUT_INTERVAL))
          )
            unlockedSellingWalletIds.push(
              paymentRequest.SmartContractWallet?.id,
            );

          await prisma.paymentRequest.update({
            where: { id: paymentRequest.id },
            data: {
              SmartContractWallet:
                paymentRequest.SmartContractWallet == null
                  ? undefined
                  : {
                      update: {
                        //we expect there not to be a pending transaction. Otherwise we do not unlock the wallet
                        lockedAt:
                          (paymentRequest.SmartContractWallet
                            ?.pendingTransactionId != null &&
                            paymentRequest.SmartContractWallet
                              ?.pendingTransactionId ==
                              paymentRequest.currentTransactionId) ||
                          (paymentRequest.SmartContractWallet?.lockedAt &&
                            new Date(
                              paymentRequest.SmartContractWallet.lockedAt,
                            ) <
                              new Date(
                                Date.now() - DEFAULTS.TX_TIMEOUT_INTERVAL,
                              ))
                            ? null
                            : undefined,
                        pendingTransactionId:
                          (paymentRequest.SmartContractWallet
                            ?.pendingTransactionId != null &&
                            paymentRequest.SmartContractWallet
                              ?.pendingTransactionId ==
                              paymentRequest.currentTransactionId) ||
                          (paymentRequest.SmartContractWallet?.lockedAt &&
                            new Date(
                              paymentRequest.SmartContractWallet.lockedAt,
                            ) <
                              new Date(
                                Date.now() - DEFAULTS.TX_TIMEOUT_INTERVAL,
                              ))
                            ? null
                            : undefined,
                      },
                    },
              CurrentTransaction: {
                update: {
                  status: TransactionStatus.FailedViaTimeout,
                },
              },
              ActionHistory: {
                connect: {
                  id: paymentRequest.nextActionId,
                },
              },
              NextAction: {
                create: {
                  requestedAction: PaymentAction.WaitingForExternalAction,
                  errorNote: 'Timeout when waiting for transaction',
                  errorType: PaymentErrorType.Unknown,
                },
              },
            },
          });
        }
      }
    });
  } catch (error) {
    logger.error('Error updating timed out payment requests', { error: error });
  }
  try {
    await prisma.$transaction(async (prisma) => {
      const result = await prisma.purchaseRequest.findMany({
        where: {
          NextAction: {
            requestedAction: {
              in: [
                PurchasingAction.FundsLockingInitiated,
                PurchasingAction.WithdrawRefundInitiated,
                PurchasingAction.SetRefundRequestedInitiated,
                PurchasingAction.UnSetRefundRequestedInitiated,
              ],
            },
          },
          OR: [
            {
              updatedAt: {
                lt: new Date(
                  Date.now() -
                    //15 minutes for timeouts, check every tx older than 1 minute
                    CONFIG.WALLET_LOCK_TIMEOUT_INTERVAL,
                ),
              },
              CurrentTransaction: null,
            },
            {
              CurrentTransaction: {
                updatedAt: {
                  lt: new Date(
                    Date.now() -
                      //15 minutes for timeouts, check every tx older than 1 minute
                      DEFAULTS.TX_TIMEOUT_INTERVAL,
                  ),
                },
              },
            },
          ],
        },
        include: { SmartContractWallet: { where: { deletedAt: null } } },
      });
      for (const purchaseRequest of result) {
        if (purchaseRequest.currentTransactionId == null) {
          if (
            purchaseRequest.SmartContractWallet != null &&
            purchaseRequest.SmartContractWallet.pendingTransactionId == null &&
            purchaseRequest.SmartContractWallet.lockedAt &&
            new Date(purchaseRequest.SmartContractWallet.lockedAt) <
              new Date(Date.now() - CONFIG.WALLET_LOCK_TIMEOUT_INTERVAL)
          )
            unlockedPurchasingWalletIds.push(
              purchaseRequest.SmartContractWallet?.id,
            );

          await prisma.purchaseRequest.update({
            where: { id: purchaseRequest.id },
            data: {
              SmartContractWallet:
                purchaseRequest.SmartContractWallet == null
                  ? undefined
                  : {
                      update: {
                        //we expect there not to be a pending transaction. Otherwise we do not unlock the wallet
                        lockedAt:
                          purchaseRequest.SmartContractWallet
                            .pendingTransactionId == null &&
                          purchaseRequest.SmartContractWallet.lockedAt &&
                          new Date(
                            purchaseRequest.SmartContractWallet.lockedAt,
                          ) <
                            new Date(
                              Date.now() - CONFIG.WALLET_LOCK_TIMEOUT_INTERVAL,
                            )
                            ? null
                            : undefined,
                      },
                    },
              ActionHistory: {
                connect: {
                  id: purchaseRequest.nextActionId,
                },
              },
              NextAction: {
                create: {
                  requestedAction: PurchasingAction.WaitingForExternalAction,
                  errorNote: 'Timeout when locking',
                  errorType: PurchaseErrorType.Unknown,
                },
              },
            },
          });
        } else {
          if (
            (purchaseRequest.SmartContractWallet?.pendingTransactionId !=
              null &&
              purchaseRequest.SmartContractWallet?.pendingTransactionId ==
                purchaseRequest.currentTransactionId) ||
            (purchaseRequest.SmartContractWallet?.lockedAt &&
              new Date(purchaseRequest.SmartContractWallet.lockedAt) <
                new Date(Date.now() - DEFAULTS.TX_TIMEOUT_INTERVAL))
          )
            unlockedPurchasingWalletIds.push(
              purchaseRequest.SmartContractWallet?.id,
            );

          await prisma.purchaseRequest.update({
            where: { id: purchaseRequest.id },
            data: {
              SmartContractWallet:
                purchaseRequest.SmartContractWallet == null
                  ? undefined
                  : {
                      update: {
                        //we expect there not to be a pending transaction. Otherwise we do not unlock the wallet
                        lockedAt:
                          (purchaseRequest.SmartContractWallet
                            ?.pendingTransactionId != null &&
                            purchaseRequest.SmartContractWallet
                              ?.pendingTransactionId ==
                              purchaseRequest.currentTransactionId) ||
                          (purchaseRequest.SmartContractWallet?.lockedAt &&
                            new Date(
                              purchaseRequest.SmartContractWallet.lockedAt,
                            ) <
                              new Date(
                                Date.now() - DEFAULTS.TX_TIMEOUT_INTERVAL,
                              ))
                            ? null
                            : undefined,
                        pendingTransactionId:
                          (purchaseRequest.SmartContractWallet
                            ?.pendingTransactionId != null &&
                            purchaseRequest.SmartContractWallet
                              ?.pendingTransactionId ==
                              purchaseRequest.currentTransactionId) ||
                          (purchaseRequest.SmartContractWallet?.lockedAt &&
                            new Date(
                              purchaseRequest.SmartContractWallet.lockedAt,
                            ) <
                              new Date(
                                Date.now() - DEFAULTS.TX_TIMEOUT_INTERVAL,
                              ))
                            ? null
                            : undefined,
                      },
                    },
              CurrentTransaction: {
                update: {
                  status: TransactionStatus.FailedViaTimeout,
                },
              },
              ActionHistory: {
                connect: {
                  id: purchaseRequest.nextActionId,
                },
              },
              NextAction: {
                create: {
                  requestedAction: PurchasingAction.WaitingForExternalAction,
                  errorNote: 'Timeout when waiting for transaction',
                  errorType: PurchaseErrorType.Unknown,
                },
              },
            },
          });
        }
      }
    });
  } catch (error) {
    logger.error('Error updating timed out purchasing requests', {
      error: error,
    });
  }
  try {
    await prisma.$transaction(async (prisma) => {
      const result = await prisma.registryRequest.findMany({
        where: {
          state: {
            in: [
              RegistrationState.RegistrationInitiated,
              RegistrationState.DeregistrationInitiated,
            ],
          },
          SmartContractWallet: { deletedAt: null },
          OR: [
            {
              updatedAt: {
                lt: new Date(
                  Date.now() -
                    //15 minutes for timeouts, check every tx older than 1 minute
                    CONFIG.WALLET_LOCK_TIMEOUT_INTERVAL,
                ),
              },
              CurrentTransaction: null,
            },
            {
              CurrentTransaction: {
                updatedAt: {
                  lt: new Date(
                    Date.now() -
                      //15 minutes for timeouts, check every tx older than 1 minute
                      DEFAULTS.TX_TIMEOUT_INTERVAL,
                  ),
                },
              },
            },
          ],
        },
        include: { SmartContractWallet: true },
      });

      for (const registryRequest of result) {
        if (registryRequest.currentTransactionId == null) {
          if (
            registryRequest.SmartContractWallet != null &&
            registryRequest.SmartContractWallet.pendingTransactionId == null &&
            registryRequest.SmartContractWallet.lockedAt &&
            new Date(registryRequest.SmartContractWallet.lockedAt) <
              new Date(Date.now() - CONFIG.WALLET_LOCK_TIMEOUT_INTERVAL)
          )
            unlockedSellingWalletIds.push(
              registryRequest.SmartContractWallet?.id,
            );

          await prisma.registryRequest.update({
            where: { id: registryRequest.id },
            data: {
              SmartContractWallet:
                registryRequest.SmartContractWallet == null
                  ? undefined
                  : {
                      update: {
                        //we expect there not to be a pending transaction. Otherwise we do not unlock the wallet
                        lockedAt:
                          registryRequest.SmartContractWallet
                            .pendingTransactionId == null &&
                          registryRequest.SmartContractWallet.lockedAt &&
                          new Date(
                            registryRequest.SmartContractWallet.lockedAt,
                          ) <
                            new Date(
                              Date.now() - CONFIG.WALLET_LOCK_TIMEOUT_INTERVAL,
                            )
                            ? null
                            : undefined,
                      },
                    },
              state:
                registryRequest.state == RegistrationState.RegistrationInitiated
                  ? RegistrationState.RegistrationFailed
                  : RegistrationState.DeregistrationFailed,
              error: 'Timeout, force unlocked',
            },
          });
        } else {
          if (
            (registryRequest.SmartContractWallet?.pendingTransactionId !=
              null &&
              registryRequest.SmartContractWallet?.pendingTransactionId ==
                registryRequest.currentTransactionId) ||
            (registryRequest.SmartContractWallet?.lockedAt &&
              new Date(registryRequest.SmartContractWallet.lockedAt) <
                new Date(Date.now() - DEFAULTS.TX_TIMEOUT_INTERVAL))
          )
            unlockedSellingWalletIds.push(
              registryRequest.SmartContractWallet?.id,
            );

          await prisma.registryRequest.update({
            where: { id: registryRequest.id },
            data: {
              SmartContractWallet:
                registryRequest.SmartContractWallet == null
                  ? undefined
                  : {
                      update: {
                        //we expect there not to be a pending transaction. Otherwise we do not unlock the wallet
                        lockedAt:
                          (registryRequest.SmartContractWallet
                            ?.pendingTransactionId != null &&
                            registryRequest.SmartContractWallet
                              ?.pendingTransactionId ==
                              registryRequest.currentTransactionId) ||
                          (registryRequest.SmartContractWallet?.lockedAt &&
                            new Date(
                              registryRequest.SmartContractWallet.lockedAt,
                            ) <
                              new Date(
                                Date.now() - DEFAULTS.TX_TIMEOUT_INTERVAL,
                              ))
                            ? null
                            : undefined,
                        pendingTransactionId:
                          (registryRequest.SmartContractWallet
                            ?.pendingTransactionId != null &&
                            registryRequest.SmartContractWallet
                              ?.pendingTransactionId ==
                              registryRequest.currentTransactionId) ||
                          (registryRequest.SmartContractWallet?.lockedAt &&
                            new Date(
                              registryRequest.SmartContractWallet.lockedAt,
                            ) <
                              new Date(
                                Date.now() - DEFAULTS.TX_TIMEOUT_INTERVAL,
                              ))
                            ? null
                            : undefined,
                      },
                    },
              CurrentTransaction: {
                update: {
                  status: TransactionStatus.FailedViaTimeout,
                },
              },
              state:
                registryRequest.state == RegistrationState.RegistrationInitiated
                  ? RegistrationState.RegistrationFailed
                  : RegistrationState.DeregistrationFailed,
            },
          });
        }
      }
    });
  } catch (error) {
    logger.error('Error updating timed out registry requests', {
      error: error,
    });
  }
  try {
    const lockedHotWallets = await prisma.hotWallet.findMany({
      where: {
        PendingTransaction: {
          //if the transaction has been checked in the last 30 seconds, we skip it
          lastCheckedAt: {
            lte: new Date(Date.now() - 1000 * 60 * 1),
          },
        },
        deletedAt: null,
        OR: [
          {
            lockedAt: {
              lt: new Date(Date.now() - CONFIG.WALLET_LOCK_TIMEOUT_INTERVAL),
            },
          },
          { lockedAt: null },
        ],
      },
      include: {
        PendingTransaction: true,
        PaymentSource: {
          include: { PaymentSourceConfig: true },
        },
      },
    });

    await Promise.allSettled(
      lockedHotWallets.map(async (wallet) => {
        try {
          if (wallet.PendingTransaction == null) {
            logger.error(
              `Wallet ${wallet.id} has no pending transaction when expected. Skipping...`,
            );
            return;
          }
          const txHash = wallet.PendingTransaction.txHash;
          if (txHash == null) {
            await prisma.hotWallet.update({
              where: { id: wallet.id, deletedAt: null },
              data: {
                PendingTransaction: { disconnect: true },
                lockedAt: null,
              },
            });
            if (wallet.type == HotWalletType.Selling) {
              unlockedSellingWalletIds.push(wallet.id);
            } else if (wallet.type == HotWalletType.Purchasing) {
              unlockedPurchasingWalletIds.push(wallet.id);
            }
            return;
          }

          const blockfrostKey =
            wallet.PaymentSource.PaymentSourceConfig.rpcProviderApiKey;
          const provider = new BlockfrostProvider(blockfrostKey);
          const txInfo = await provider.fetchTxInfo(txHash);
          if (txInfo) {
            await prisma.hotWallet.update({
              where: { id: wallet.id, deletedAt: null },
              data: {
                PendingTransaction: { disconnect: true },
                lockedAt: null,
              },
            });
            if (wallet.type == HotWalletType.Selling) {
              unlockedSellingWalletIds.push(wallet.id);
            } else if (wallet.type == HotWalletType.Purchasing) {
              unlockedPurchasingWalletIds.push(wallet.id);
            }
          } else {
            await prisma.transaction.update({
              where: { id: wallet.PendingTransaction.id },
              data: { lastCheckedAt: new Date() },
            });
          }
        } catch (error) {
          logger.error(
            `Error updating wallet transaction hash: ${errorToString(error)}`,
          );
        }
      }),
    );

    const timedOutLockedHotWallets = await prisma.hotWallet.findMany({
      where: {
        lockedAt: {
          lt: new Date(Date.now() - CONFIG.WALLET_LOCK_TIMEOUT_INTERVAL),
        },
        deletedAt: null,
        PendingTransaction: null,
      },
      include: {
        PaymentSource: { include: { PaymentSourceConfig: true } },
      },
    });
    await Promise.allSettled(
      timedOutLockedHotWallets.map(async (wallet) => {
        try {
          await prisma.hotWallet.update({
            where: { id: wallet.id, deletedAt: null },
            data: {
              lockedAt: null,
            },
          });

          if (wallet.type == HotWalletType.Selling) {
            unlockedSellingWalletIds.push(wallet.id);
          } else if (wallet.type == HotWalletType.Purchasing) {
            unlockedPurchasingWalletIds.push(wallet.id);
          }
        } catch (error) {
          logger.error(
            `Error updating timed out wallet: ${errorToString(error)}`,
          );
        }
      }),
    );
    const uniqueUnlockedSellingWalletIds = [
      ...new Set(unlockedSellingWalletIds),
    ].filter((id) => id != null);
    const uniqueUnlockedPurchasingWalletIds = [
      ...new Set(unlockedPurchasingWalletIds),
    ].filter((id) => id != null);
    //TODO: reset initialized actions
    if (uniqueUnlockedSellingWalletIds.length > 0) {
      try {
        await submitResultV1();
      } catch (error) {
        logger.error(`Error initiating submit result: ${errorToString(error)}`);
      }
      try {
        await authorizeRefundV1();
      } catch (error) {
        logger.error(`Error initiating refunds: ${errorToString(error)}`);
      }
      try {
        await collectOutstandingPaymentsV1();
      } catch (error) {
        logger.error(
          `Error initiating collect outstanding payments: ${errorToString(error)}`,
        );
      }
      try {
        await registerAgentV1();
      } catch (error) {
        logger.error(
          `Error initiating register agent: ${errorToString(error)}`,
        );
      }
      try {
        await deRegisterAgentV1();
      } catch (error) {
        logger.error(
          `Error initiating deregister agent: ${errorToString(error)}`,
        );
      }
      try {
        await authorizeRefundV1();
      } catch (error) {
        logger.error(
          `Error initiating authorize refund: ${errorToString(error)}`,
        );
      }
    }
    if (uniqueUnlockedPurchasingWalletIds.length > 0) {
      try {
        await collectRefundV1();
      } catch (error) {
        logger.error(
          `Error initiating collect refund: ${errorToString(error)}`,
        );
      }
      try {
        await requestRefundsV1();
      } catch (error) {
        logger.error(
          `Error initiating request refund: ${errorToString(error)}`,
        );
      }
      try {
        await cancelRefundsV1();
      } catch (error) {
        logger.error(`Error initiating cancel refund: ${errorToString(error)}`);
      }
      try {
        await batchLatestPaymentEntriesV1();
      } catch (error) {
        logger.error(
          `Error initiating batch latest payment entries: ${errorToString(error)}`,
        );
      }
    }
    try {
      const errorHotWallets = await prisma.hotWallet.findMany({
        where: {
          PendingTransaction: { isNot: null },
          lockedAt: null,
          deletedAt: null,
        },
        include: { PendingTransaction: true },
      });
      for (const hotWallet of errorHotWallets) {
        logger.error(
          `Hot wallet ${hotWallet.id} was in an invalid locked state (this is likely a bug please report it with the following transaction hash): ${hotWallet.PendingTransaction?.txHash}`,
        );
        await prisma.hotWallet.update({
          where: { id: hotWallet.id, deletedAt: null },
          data: {
            lockedAt: null,
            PendingTransaction: { disconnect: true },
          },
        });
      }
    } catch (error) {
      logger.error(`Error updating wallet transaction hash`, { error: error });
    }
  } catch (error) {
    logger.error(`Error updating wallet transaction hash`, { error: error });
  } finally {
    release();
  }
}
