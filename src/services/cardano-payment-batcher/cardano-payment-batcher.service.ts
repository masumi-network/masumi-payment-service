import {
  HotWallet,
  HotWalletType,
  PurchaseErrorType,
  PurchasingAction,
  TransactionStatus,
} from '@prisma/client';
import { prisma } from '@/utils/db';
import {
  BlockfrostProvider,
  SLOT_CONFIG_NETWORK,
  Transaction,
  unixTimeToEnclosingSlot,
} from '@meshsdk/core';
import { logger } from '@/utils/logger';
import { generateWalletExtended } from '@/utils/generator/wallet-generator';
import {
  getDatumFromBlockchainIdentifier,
  SmartContractState,
} from '@/utils/generator/contract-generator';
import { convertNetwork } from '@/utils/converter/network-convert';
import { convertErrorString } from '@/utils/converter/error-string-convert';
import { Mutex, MutexInterface, tryAcquire } from 'async-mutex';
import cbor from 'cbor';
import {
  Address,
  Datum,
  toPlutusData,
  toValue,
  TransactionOutput,
} from '@meshsdk/core-cst';
import { CONSTANTS } from '@/utils/config';

const mutex = new Mutex();

export async function batchLatestPaymentEntriesV1() {
  const maxBatchSize = 10;

  let release: MutexInterface.Releaser | null;
  try {
    release = await tryAcquire(mutex).acquire();
  } catch (e) {
    logger.info('Mutex timeout when locking', { error: e });
    return;
  }

  try {
    const paymentContractsWithWalletLocked = await prisma.$transaction(
      async (prisma) => {
        const payByTime = new Date().getTime() + 1000 * 57;
        const paymentContracts = await prisma.paymentSource.findMany({
          where: {
            deletedAt: null,
            HotWallets: {
              some: {
                PendingTransaction: null,
                type: HotWalletType.Purchasing,
                deletedAt: null,
              },
            },
          },
          include: {
            PurchaseRequests: {
              where: {
                NextAction: {
                  requestedAction: PurchasingAction.FundsLockingRequested,
                  errorType: null,
                },
                CurrentTransaction: { is: null },
                onChainState: null,
                payByTime: { gte: payByTime },
              },
              include: {
                PaidFunds: true,
                SellerWallet: true,
                SmartContractWallet: { where: { deletedAt: null } },
                NextAction: true,
                CurrentTransaction: true,
              },
              orderBy: {
                createdAt: 'asc',
              },
            },
            PaymentSourceConfig: true,
            HotWallets: {
              where: {
                PendingTransaction: null,
                lockedAt: null,
                type: HotWalletType.Purchasing,
                deletedAt: null,
              },
              include: {
                Secret: true,
              },
            },
          },
        });

        const walletsToLock: HotWallet[] = [];
        const paymentContractsToUse = [];
        for (const paymentContract of paymentContracts) {
          const purchaseRequests = [];
          for (const purchaseRequest of paymentContract.PurchaseRequests) {
            //if the purchase request times out in less than 5 minutes, we ignore it
            const maxSubmitResultTime = Date.now() - 1000 * 60 * 5;
            if (purchaseRequest.submitResultTime < maxSubmitResultTime) {
              logger.info(
                'Purchase request times out in less than 5 minutes, ignoring',
                { purchaseRequest: purchaseRequest },
              );
              await prisma.purchaseRequest.update({
                where: { id: purchaseRequest.id },
                data: {
                  NextAction: {
                    create: {
                      inputHash: purchaseRequest.inputHash,
                      requestedAction: PurchasingAction.FundsLockingRequested,
                      errorType: PurchaseErrorType.Unknown,
                      errorNote: 'Transaction timeout before sending',
                    },
                  },
                },
              });
              continue;
            }
            purchaseRequests.push(purchaseRequest);
          }
          if (purchaseRequests.length == 0) {
            continue;
          }
          paymentContract.PurchaseRequests = purchaseRequests;
          for (const wallet of paymentContract.HotWallets) {
            if (!walletsToLock.some((w) => w.id === wallet.id)) {
              walletsToLock.push(wallet);
              await prisma.hotWallet.update({
                where: { id: wallet.id, deletedAt: null },
                data: { lockedAt: new Date() },
              });
            }
          }
          if (paymentContract.PurchaseRequests.length > 0) {
            paymentContractsToUse.push(paymentContract);
          }
        }
        return paymentContractsToUse;
      },
      { isolationLevel: 'Serializable', maxWait: 10000, timeout: 10000 },
    );

    await Promise.allSettled(
      paymentContractsWithWalletLocked.map(async (paymentContract) => {
        try {
          const paymentRequests = paymentContract.PurchaseRequests;
          if (paymentRequests.length == 0) {
            logger.info(
              'No payment requests found for network ' +
                paymentContract.network +
                ' ' +
                paymentContract.smartContractAddress,
            );
            return;
          }

          const potentialWallets = paymentContract.HotWallets;
          if (potentialWallets.length == 0) {
            logger.warn('No unlocked wallet to batch payments, skipping');
            return;
          }

          const walletAmounts = await Promise.all(
            potentialWallets.map(async (wallet) => {
              const { wallet: meshWallet } = await generateWalletExtended(
                paymentContract.network,
                paymentContract.PaymentSourceConfig.rpcProviderApiKey,
                wallet.Secret.encryptedMnemonic,
              );
              const amounts = await meshWallet.getBalance();
              return {
                wallet: meshWallet,
                walletId: wallet.id,
                scriptAddress: paymentContract.smartContractAddress,
                amounts: amounts.map((amount) => ({
                  unit:
                    amount.unit.toLowerCase() == 'lovelace' ? '' : amount.unit,
                  quantity: BigInt(amount.quantity),
                })),
              };
            }),
          );
          const paymentRequestsRemaining = [...paymentRequests];
          const walletPairings = [];

          let maxBatchSizeReached = false;

          const blockchainProvider = new BlockfrostProvider(
            paymentContract.PaymentSourceConfig.rpcProviderApiKey,
          );

          const protocolParameter =
            await blockchainProvider.fetchProtocolParameters();

          for (const walletData of walletAmounts) {
            const wallet = walletData.wallet;
            const amounts = walletData.amounts;
            const potentialAddresses = await wallet.getUsedAddresses();
            if (potentialAddresses.length == 0) {
              logger.warn(
                'No addresses found for wallet ' + walletData.walletId,
              );
              continue;
            }
            const batchedPaymentRequests = [];

            let index = 0;
            while (
              paymentRequestsRemaining.length > 0 &&
              index < paymentRequestsRemaining.length
            ) {
              if (batchedPaymentRequests.length >= maxBatchSize) {
                maxBatchSizeReached = true;
                break;
              }
              const paymentRequest = paymentRequestsRemaining[index];
              const sellerAddress = paymentRequest.SellerWallet.walletAddress;
              const buyerAddress = potentialAddresses[0];
              const tmpDatum = getDatumFromBlockchainIdentifier({
                buyerAddress: buyerAddress,
                sellerAddress: sellerAddress,
                blockchainIdentifier: paymentRequest.blockchainIdentifier,
                inputHash: paymentRequest.inputHash,
                resultHash:
                  'd4735e3a265e16eee03f59718b9b5d03019c07d8b6c51f90da3a666eec13ab35',
                payByTime: BigInt(Date.now()),
                collateralReturnLovelace: 1000000000n,
                resultTime: BigInt(paymentRequest.submitResultTime),
                unlockTime: BigInt(paymentRequest.unlockTime),
                externalDisputeUnlockTime: BigInt(
                  paymentRequest.externalDisputeUnlockTime,
                ),
                newCooldownTimeSeller: BigInt(0),
                newCooldownTimeBuyer: BigInt(Date.now()),
                state: SmartContractState.FundsLocked,
              });

              const cborEncodedDatum = cbor.encode(tmpDatum.value);

              const defaultOverheadSize = 160;
              const bufferSizeCooldownTime = 15;
              const bufferSizePerUnit = 50;
              const bufferSizeTxOutputHash = 50;

              const otherUnits = paymentRequest.PaidFunds.filter(
                (amount) =>
                  amount.unit.toLowerCase() != '' &&
                  amount.unit.toLowerCase() != 'lovelace',
              ).length;

              const totalLength =
                cborEncodedDatum.byteLength +
                defaultOverheadSize +
                bufferSizeTxOutputHash +
                bufferSizeCooldownTime +
                bufferSizePerUnit * otherUnits;
              let overestimatedMinUtxoCost = BigInt(
                Math.ceil(protocolParameter.coinsPerUtxoSize * totalLength),
              );

              const lovelaceAmount =
                paymentRequest.PaidFunds.find(
                  (amount) => amount.unit == '' || amount.unit == 'lovelace',
                )?.amount ?? 0;
              const dummyOutput = new TransactionOutput(
                Address.fromBech32(walletData.scriptAddress),
                toValue([
                  ...paymentRequest.PaidFunds.filter(
                    (amount) => amount.unit != '' && amount.unit != 'lovelace',
                  ).map((amount) => ({
                    unit: amount.unit,
                    quantity: amount.amount.toString(),
                  })),
                  {
                    unit: 'lovelace',
                    quantity:
                      lovelaceAmount > overestimatedMinUtxoCost
                        ? lovelaceAmount.toString()
                        : overestimatedMinUtxoCost.toString(),
                  },
                ]),
              );
              dummyOutput.setDatum(
                Datum.newInlineData(toPlutusData(tmpDatum.value)),
              );
              const dummyCbor = dummyOutput.toCbor();
              overestimatedMinUtxoCost =
                BigInt(
                  defaultOverheadSize +
                    bufferSizeCooldownTime +
                    Math.ceil(dummyCbor.length / 2),
                ) * BigInt(protocolParameter.coinsPerUtxoSize);

              //set min ada required;
              const lovelaceRequired = paymentRequest.PaidFunds.findIndex(
                (amount) => amount.unit.toLowerCase() === '',
              );
              let overpaidLovelace = 0n;
              if (lovelaceRequired == -1) {
                overpaidLovelace = overestimatedMinUtxoCost;
                paymentRequest.PaidFunds.push({
                  unit: '',
                  amount: overestimatedMinUtxoCost,
                  id: '',
                  createdAt: new Date(),
                  updatedAt: new Date(),
                  paymentRequestId: null,
                  purchaseRequestId: null,
                  apiKeyId: null,
                  agentFixedPricingId: null,
                  sellerWithdrawnPaymentRequestId: null,
                  buyerWithdrawnPaymentRequestId: null,
                  buyerWithdrawnPurchaseRequestId: null,
                  sellerWithdrawnPurchaseRequestId: null,
                });
              } else if (
                paymentRequest.PaidFunds[lovelaceRequired].amount <
                overestimatedMinUtxoCost
              ) {
                overpaidLovelace =
                  overestimatedMinUtxoCost -
                  paymentRequest.PaidFunds[lovelaceRequired].amount;
                if (overpaidLovelace < 0n) {
                  overpaidLovelace = 0n;
                }
                //we want to be overpaid lovelace to be 0 or at least 1.43523 ada
                //example: overestimatedMinUtxoCost 3 ada
                //paidFunds 2.5 ada
                //overpaidLovelace 0.5 ada
                //we want to be overpaid lovelace to be 1.43523 ada
                //so we need to add 1.43523 ada - 0.5 ada = 0.93523 ada
                if (
                  overpaidLovelace > 0n &&
                  overpaidLovelace < CONSTANTS.MIN_COLLATERAL_LOVELACE
                ) {
                  overestimatedMinUtxoCost +=
                    CONSTANTS.MIN_COLLATERAL_LOVELACE - overpaidLovelace;
                  overpaidLovelace = CONSTANTS.MIN_COLLATERAL_LOVELACE;
                }

                paymentRequest.PaidFunds.splice(lovelaceRequired, 1);
                paymentRequest.PaidFunds.push({
                  unit: '',
                  amount: overestimatedMinUtxoCost,
                  id: '',
                  createdAt: new Date(),
                  updatedAt: new Date(),
                  paymentRequestId: null,
                  purchaseRequestId: null,
                  apiKeyId: null,
                  agentFixedPricingId: null,
                  sellerWithdrawnPaymentRequestId: null,
                  buyerWithdrawnPaymentRequestId: null,
                  buyerWithdrawnPurchaseRequestId: null,
                  sellerWithdrawnPurchaseRequestId: null,
                });
              }
              let isFulfilled = true;
              for (const paymentAmount of paymentRequest.PaidFunds) {
                const walletAmount = amounts.find(
                  (amount) => amount.unit == paymentAmount.unit,
                );
                if (
                  walletAmount == null ||
                  paymentAmount.amount > walletAmount.quantity
                ) {
                  isFulfilled = false;
                  break;
                }
              }
              if (isFulfilled) {
                batchedPaymentRequests.push({
                  paymentRequest,
                  overpaidLovelace,
                });

                paymentRequestsRemaining.splice(index, 1);
              } else {
                index++;
              }
            }
            if (batchedPaymentRequests.length > 0) {
              logger.info('Batching payments, adding wallet pairing', {
                walletId: walletData.walletId,
                scriptAddress: walletData.scriptAddress,
                batchedRequests: batchedPaymentRequests,
              });
              walletPairings.push({
                wallet: wallet,
                scriptAddress: walletData.scriptAddress,
                walletId: walletData.walletId,
                batchedRequests: batchedPaymentRequests,
              });
            }
          }
          //only go into error state if we did not reach max batch size, as otherwise we might have enough funds in other wallets
          if (
            paymentRequestsRemaining.length > 0 &&
            maxBatchSizeReached == false
          ) {
            const allWalletCount = await prisma.hotWallet.count({
              where: {
                deletedAt: null,
                type: HotWalletType.Purchasing,
                PendingTransaction: null,
                PaymentSource: {
                  id: paymentContract.id,
                },
              },
            });
            //only go into error state if all wallets were unlocked, otherwise we might have enough funds in other wallets
            if (allWalletCount == potentialWallets.length) {
              logger.warn(
                'No wallets with funds found, going into error state for',
                {
                  paymentRequestsRemaining: paymentRequestsRemaining.map(
                    (x) => x.id,
                  ),
                },
              );
              for (const paymentRequest of paymentRequestsRemaining) {
                await prisma.purchaseRequest.update({
                  where: { id: paymentRequest.id },
                  data: {
                    NextAction: {
                      create: {
                        inputHash: paymentRequest.inputHash,
                        requestedAction:
                          PurchasingAction.WaitingForManualAction,
                        errorType: PurchaseErrorType.InsufficientFunds,
                        errorNote: 'Not enough funds in wallets',
                      },
                    },
                  },
                });
              }
            }
          }

          if (walletPairings.length == 0) {
            logger.info('No purchase requests with funds found, skipping');
            return;
          }

          logger.info(
            `Batching ${walletPairings.length} payments for payment source ${paymentContract.id}`,
          );
          //do not retry, we want to fail if anything goes wrong. There should not be a possibility to pay twice
          await Promise.allSettled(
            walletPairings.map(async (walletPairing) => {
              try {
                const executeBatchedPayment = async () => {
                  const wallet = walletPairing.wallet;
                  const walletId = walletPairing.walletId;
                  const batchedRequests = walletPairing.batchedRequests;

                  //batch payments
                  const unsignedTx = new Transaction({
                    initiator: wallet,
                    fetcher: blockchainProvider,
                  }).setMetadata(674, {
                    msg: ['Masumi', 'PaymentBatched'],
                  });
                  logger.info('Batching payments, adding metadata');
                  for (const data of batchedRequests) {
                    const buyerAddress = wallet.getUsedAddress().toBech32();
                    const sellerAddress =
                      data.paymentRequest.SellerWallet.walletAddress;
                    const submitResultTime =
                      data.paymentRequest.submitResultTime;
                    const unlockTime = data.paymentRequest.unlockTime;
                    const externalDisputeUnlockTime =
                      data.paymentRequest.externalDisputeUnlockTime;

                    if (data.paymentRequest.payByTime == null) {
                      throw new Error(
                        'Pay by time is null, this is deprecated',
                      );
                    }

                    const datum = getDatumFromBlockchainIdentifier({
                      buyerAddress: buyerAddress,
                      sellerAddress: sellerAddress,
                      blockchainIdentifier:
                        data.paymentRequest.blockchainIdentifier,
                      inputHash: data.paymentRequest.inputHash,
                      payByTime: data.paymentRequest.payByTime,
                      collateralReturnLovelace: data.overpaidLovelace,
                      resultHash: '',
                      resultTime: submitResultTime,
                      unlockTime: unlockTime,
                      externalDisputeUnlockTime: externalDisputeUnlockTime,
                      newCooldownTimeSeller: BigInt(0),
                      newCooldownTimeBuyer: BigInt(0),
                      state: SmartContractState.FundsLocked,
                    });
                    logger.info(
                      'Batching payments, adding datum for payment request',
                      {
                        paymentRequestId: data.paymentRequest.id,
                      },
                    );

                    unsignedTx.sendAssets(
                      {
                        address: walletPairing.scriptAddress,
                        datum,
                      },
                      data.paymentRequest.PaidFunds.map((amount) => ({
                        unit: amount.unit == '' ? 'lovelace' : amount.unit,
                        quantity: amount.amount.toString(),
                      })),
                    );
                  }

                  for (const request of batchedRequests) {
                    logger.info(
                      'Batching payments, updating purchase request',
                      {
                        paymentRequestId: request.paymentRequest.id,
                      },
                    );
                    await prisma.purchaseRequest.update({
                      where: { id: request.paymentRequest.id },
                      data: {
                        NextAction: {
                          update: {
                            requestedAction:
                              PurchasingAction.FundsLockingInitiated,
                          },
                        },
                        collateralReturnLovelace: request.overpaidLovelace,
                        SmartContractWallet: {
                          connect: {
                            id: walletId,
                          },
                        },
                        CurrentTransaction: {
                          create: {
                            txHash: '',
                            status: TransactionStatus.Pending,
                            BlocksWallet: {
                              connect: {
                                id: walletId,
                              },
                            },
                          },
                        },
                        TransactionHistory: request.paymentRequest
                          .CurrentTransaction
                          ? {
                              connect: {
                                id: request.paymentRequest.CurrentTransaction
                                  .id,
                              },
                            }
                          : undefined,
                      },
                    });
                  }

                  logger.info(
                    'Batching payments, purchase request initialized',
                  );

                  const invalidBefore =
                    unixTimeToEnclosingSlot(
                      Date.now() - 150000,
                      SLOT_CONFIG_NETWORK[
                        convertNetwork(paymentContract.network)
                      ],
                    ) - 1;

                  const invalidAfter =
                    unixTimeToEnclosingSlot(
                      Date.now() + 150000,
                      SLOT_CONFIG_NETWORK[
                        convertNetwork(paymentContract.network)
                      ],
                    ) + 5;
                  unsignedTx.setNetwork(
                    convertNetwork(paymentContract.network),
                  );
                  unsignedTx.txBuilder.invalidBefore(invalidBefore);
                  unsignedTx.txBuilder.invalidHereafter(invalidAfter);

                  const completeTx = await unsignedTx.build();
                  logger.info('Batching payments, complete tx built');
                  const signedTx = await wallet.signTx(completeTx);
                  logger.info('Batching payments, tx signed');
                  const txHash = await wallet.submitTx(signedTx);

                  logger.info('Batching payments, tx submitted', {
                    txHash: txHash,
                  });

                  //submit the transaction to the blockchain

                  //update purchase requests
                  for (const request of batchedRequests) {
                    await prisma.purchaseRequest.update({
                      where: { id: request.paymentRequest.id },
                      data: {
                        CurrentTransaction: {
                          update: {
                            txHash: txHash,
                          },
                        },
                      },
                    });
                  }
                  logger.info('Batching payments, purchase request updated');

                  return true;
                };
                return await Promise.race([
                  new Promise<boolean>((_, reject) => {
                    setTimeout(
                      () => {
                        reject(new Error('Timeout batching purchase requests'));
                      },
                      //30 seconds timeout
                      30000,
                    );
                  }),
                  executeBatchedPayment(),
                ]);
              } catch (error) {
                logger.error('Error batching payments', {
                  error: error,
                  walletPairing: walletPairing.batchedRequests,
                  walletId: walletPairing.walletId,
                });
                for (const batchedRequest of walletPairing.batchedRequests) {
                  await prisma.purchaseRequest.update({
                    where: { id: batchedRequest.paymentRequest.id },
                    data: {
                      NextAction: {
                        update: {
                          requestedAction:
                            PurchasingAction.WaitingForManualAction,
                          errorType: PurchaseErrorType.Unknown,
                          errorNote:
                            'Batching payments failed: ' +
                            convertErrorString(error),
                        },
                      },
                    },
                  });
                }

                await prisma.hotWallet.update({
                  where: { id: walletPairing.walletId, deletedAt: null },
                  data: {
                    lockedAt: null,
                    PendingTransaction: { disconnect: true },
                  },
                });

                throw error;
              }
            }),
          );
        } catch (error) {
          logger.error('Error batching payments outer', { error: error });

          const potentiallyFailedPurchaseRequests =
            paymentContract.PurchaseRequests;
          const failedPurchaseRequests = await prisma.purchaseRequest.findMany({
            where: {
              id: { in: potentiallyFailedPurchaseRequests.map((x) => x.id) },
              CurrentTransaction: {
                is: null,
              },
              NextAction: {
                requestedAction: PurchasingAction.FundsLockingRequested,
              },
            },
          });

          await prisma.hotWallet.updateMany({
            where: {
              id: { in: paymentContract.HotWallets.map((x) => x.id) },
              deletedAt: null,
              pendingTransactionId: null,
              type: HotWalletType.Purchasing,
            },
            data: {
              lockedAt: null,
            },
          });

          await Promise.allSettled(
            failedPurchaseRequests.map(async (x) => {
              await prisma.purchaseRequest.update({
                where: { id: x.id },
                data: {
                  NextAction: {
                    update: {
                      requestedAction: PurchasingAction.WaitingForManualAction,
                      errorType: PurchaseErrorType.Unknown,
                      errorNote:
                        'Outer error: Batching payments failed: ' +
                        convertErrorString(error),
                    },
                  },
                },
              });
            }),
          );
          throw error;
        }
      }),
    );
  } catch (error) {
    logger.error('Error batching payments', error);
  } finally {
    release();
  }
}
