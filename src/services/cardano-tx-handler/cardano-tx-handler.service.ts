import {
  OnChainState,
  PaymentAction,
  PaymentErrorType,
  PaymentType,
  Prisma,
  PurchaseErrorType,
  PurchasingAction,
  RegistrationState,
  TransactionStatus,
  WalletType,
} from '@prisma/client';
import { Sema } from 'async-sema';
import { prisma } from '@/utils/db';
import { logger } from '@/utils/logger';
import { BlockFrostAPI } from '@blockfrost/blockfrost-js';
import {
  PlutusDatumSchema,
  Transaction,
} from '@emurgo/cardano-serialization-lib-nodejs';
import { decodeV1ContractDatum } from '@/utils/converter/string-datum-convert';
import {
  advancedRetry,
  advancedRetryAll,
  delayErrorResolver,
} from 'advanced-retry';
import {
  convertNewPaymentActionAndError,
  convertNewPurchasingActionAndError,
} from '@/utils/logic/state-transitions';
import { convertNetwork } from '@/utils/converter/network-convert';
import { deserializeDatum } from '@meshsdk/core';
import { SmartContractState } from '@/utils/generator/contract-generator';

const updateMutex = new Sema(1);
export async function checkLatestTransactions(
  { maxParallelTransactions = 50 }: { maxParallelTransactions?: number } = {
    maxParallelTransactions: 50,
  },
) {
  const acquiredMutex = await updateMutex.tryAcquire();
  //if we are already performing an update, we wait for it to finish and return
  if (!acquiredMutex) return await updateMutex.acquire();

  try {
    //only support web3 cardano v1 for now
    const paymentContracts = await prisma.$transaction(
      async (prisma) => {
        const paymentContracts = await prisma.paymentSource.findMany({
          where: {
            paymentType: PaymentType.Web3CardanoV1,
            OR: [
              { syncInProgress: false },
              {
                syncInProgress: true,
                updatedAt: {
                  lte: new Date(
                    Date.now() -
                      //3 minutes
                      1000 * 60 * 3,
                  ),
                },
              },
            ],
          },
          include: {
            PaymentSourceConfig: true,
          },
        });
        if (paymentContracts.length == 0) {
          logger.warn(
            'No payment contracts found, skipping update. It could be that an other instance is already syncing',
          );
          return null;
        }

        await prisma.paymentSource.updateMany({
          where: { id: { in: paymentContracts.map((x) => x.id) } },
          data: { syncInProgress: true },
        });
        return paymentContracts.map((x) => {
          return { ...x, syncInProgress: true };
        });
      },
      {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        timeout: 10000,
        maxWait: 10000,
      },
    );
    if (paymentContracts == null) return;
    try {
      const results = await Promise.allSettled(
        paymentContracts.map(async (paymentContract) => {
          const blockfrost = new BlockFrostAPI({
            projectId: paymentContract.PaymentSourceConfig.rpcProviderApiKey,
            network: convertNetwork(paymentContract.network),
          });

          const registryRequests = await prisma.registryRequest.findMany({
            where: {
              PaymentSource: {
                id: paymentContract.id,
              },
              state: {
                in: [
                  RegistrationState.RegistrationInitiated,
                  RegistrationState.DeregistrationInitiated,
                ],
              },
              CurrentTransaction: {
                isNot: null,
              },
              agentIdentifier: { not: null },
              updatedAt: {
                lt: new Date(
                  Date.now() -
                    //15 minutes for timeouts, check every tx older than 1 minute
                    1000 * 60 * 1,
                ),
              },
            },
            include: {
              CurrentTransaction: { include: { BlocksWallet: true } },
            },
          });
          const checkedRegistryRequests = await advancedRetryAll({
            operations: registryRequests.map((registryRequest) => async () => {
              const owner = await blockfrost.assetsAddresses(
                registryRequest.agentIdentifier!,
                { order: 'desc' },
              );

              if (
                registryRequest.state == RegistrationState.RegistrationInitiated
              ) {
                if (owner.length >= 1 && owner[0].quantity == '1') {
                  await prisma.registryRequest.update({
                    where: { id: registryRequest.id },
                    data: {
                      state: RegistrationState.RegistrationConfirmed,
                      CurrentTransaction: {
                        update: {
                          status: TransactionStatus.Confirmed,
                          BlocksWallet:
                            registryRequest.CurrentTransaction?.BlocksWallet !=
                            null
                              ? { disconnect: true }
                              : undefined,
                        },
                      },
                    },
                  });
                  if (
                    registryRequest.CurrentTransaction?.BlocksWallet != null
                  ) {
                    await prisma.hotWallet.update({
                      where: {
                        id: registryRequest.CurrentTransaction.BlocksWallet.id,
                      },
                      data: {
                        lockedAt: null,
                      },
                    });
                  }
                } else {
                  await prisma.registryRequest.update({
                    where: { id: registryRequest.id },
                    data: {
                      updatedAt: new Date(),
                    },
                  });
                }
              } else if (
                registryRequest.state ==
                RegistrationState.DeregistrationInitiated
              ) {
                if (owner.length == 0 || owner[0].quantity == '0') {
                  await prisma.registryRequest.update({
                    where: { id: registryRequest.id },
                    data: {
                      state: RegistrationState.DeregistrationConfirmed,
                      CurrentTransaction: {
                        update: {
                          status: TransactionStatus.Confirmed,
                          BlocksWallet:
                            registryRequest.CurrentTransaction?.BlocksWallet !=
                            null
                              ? { disconnect: true }
                              : undefined,
                        },
                      },
                    },
                  });
                  if (
                    registryRequest.CurrentTransaction?.BlocksWallet != null
                  ) {
                    await prisma.hotWallet.update({
                      where: {
                        id: registryRequest.CurrentTransaction.BlocksWallet.id,
                      },
                      data: {
                        lockedAt: null,
                      },
                    });
                  }
                } else {
                  await prisma.registryRequest.update({
                    where: { id: registryRequest.id },
                    data: {
                      updatedAt: new Date(),
                    },
                  });
                }
              }
            }),
            errorResolvers: [
              delayErrorResolver({
                configuration: {
                  maxRetries: 5,
                  backoffMultiplier: 2,
                  initialDelayMs: 500,
                  maxDelayMs: 1500,
                },
              }),
            ],
          });

          checkedRegistryRequests.forEach((x) => {
            if (x.success == false) {
              logger.warn('Failed to update registry request');
            }
          });

          const latestIdentifier = paymentContract.lastIdentifierChecked;

          let latestTx: { tx_hash: string }[] = [];
          let foundTx = -1;
          let index = 0;
          do {
            index++;
            const txs = await blockfrost.addressesTransactions(
              paymentContract.smartContractAddress,
              { page: index, order: 'desc' },
            );
            if (txs.length == 0) {
              if (latestTx.length == 0) {
                logger.warn('No transactions found for payment contract', {
                  paymentContract: paymentContract,
                });
              }
              break;
            }

            latestTx.push(...txs);
            foundTx = txs.findIndex((tx) => tx.tx_hash == latestIdentifier);
            if (foundTx != -1) {
              const latestTxIndex = latestTx.findIndex(
                (tx) => tx.tx_hash == latestIdentifier,
              );
              latestTx = latestTx.slice(0, latestTxIndex);
            }
          } while (foundTx == -1);

          //invert to get oldest first
          latestTx = latestTx.reverse();

          if (latestTx.length == 0) {
            logger.info('No new transactions found for payment contract', {
              paymentContract: paymentContract,
            });
            return;
          }

          const batchCount = Math.ceil(
            latestTx.length / maxParallelTransactions,
          );
          const txData: {
            tx: { tx_hash: string };
            utxos: {
              hash: string;
              inputs: {
                address: string;
                amount: { unit: string; quantity: string }[];
                tx_hash: string;
                output_index: number;
                data_hash: string | null;
                inline_datum: string | null;
                reference_script_hash: string | null;
                collateral: boolean;
                reference?: boolean;
              }[];
              outputs: {
                address: string;
                amount: { unit: string; quantity: string }[];
                output_index: number;
                data_hash: string | null;
                inline_datum: string | null;
                collateral: boolean;
                reference_script_hash: string | null;
                consumed_by_tx?: string | null;
              }[];
            };
            transaction: Transaction;
          }[] = [];

          for (let i = 0; i < batchCount; i++) {
            const txBatch = latestTx.slice(
              i * maxParallelTransactions,
              Math.min((i + 1) * maxParallelTransactions, latestTx.length),
            );

            const txDataBatch = await advancedRetryAll({
              operations: txBatch.map((tx) => async () => {
                const cbor = await blockfrost.txsCbor(tx.tx_hash);
                const utxos = await blockfrost.txsUtxos(tx.tx_hash);
                const transaction = Transaction.from_bytes(
                  Buffer.from(cbor.cbor, 'hex'),
                );
                return { tx: tx, utxos: utxos, transaction: transaction };
              }),
              errorResolvers: [
                delayErrorResolver({
                  configuration: {
                    maxRetries: 5,
                    backoffMultiplier: 2,
                    initialDelayMs: 500,
                    maxDelayMs: 15000,
                  },
                }),
              ],
            });
            //filter out failed operations
            const filteredTxData = txDataBatch
              .filter((x) => x.success == true && x.result != undefined)
              .map((x) => x.result!);
            //log warning for failed operations
            const failedTxData = txDataBatch.filter((x) => x.success == false);
            if (failedTxData.length > 0) {
              logger.warn('Failed to get data for transactions: ignoring ', {
                tx: failedTxData,
              });
            }
            filteredTxData.forEach((x) => txData.push(x));
          }

          for (const tx of txData) {
            const utxos = tx.utxos;
            const inputs = utxos.inputs;
            const outputs = utxos.outputs;

            const valueInputs = inputs.filter((x) => {
              return x.address == paymentContract.smartContractAddress;
            });
            const valueOutputs = outputs.filter((x) => {
              return x.address == paymentContract.smartContractAddress;
            });

            const redeemers = tx.transaction.witness_set().redeemers();

            if (redeemers == null) {
              //payment transaction
              if (valueInputs.length != 0) {
                //invalid transaction
                continue;
              }

              for (const output of valueOutputs) {
                const outputDatum = output.inline_datum;
                if (outputDatum == null) {
                  //invalid transaction
                  continue;
                }
                const decodedOutputDatum: unknown =
                  deserializeDatum(outputDatum);
                const decodedNewContract =
                  decodeV1ContractDatum(decodedOutputDatum);
                if (decodedNewContract == null) {
                  //invalid transaction
                  continue;
                }

                await prisma.$transaction(
                  async (prisma) => {
                    const sellerWallet = await prisma.walletBase.findUnique({
                      where: {
                        paymentSourceId_walletVkey_type: {
                          paymentSourceId: paymentContract.id,
                          walletVkey: decodedNewContract.seller,
                          type: WalletType.Seller,
                        },
                      },
                    });
                    if (sellerWallet == null) {
                      return;
                    }

                    const dbEntry = await prisma.purchaseRequest.findUnique({
                      where: {
                        paymentSourceId_blockchainIdentifier: {
                          paymentSourceId: paymentContract.id,
                          blockchainIdentifier:
                            decodedNewContract.blockchainIdentifier,
                        },
                        NextAction: {
                          requestedAction:
                            PurchasingAction.FundsLockingInitiated,
                        },
                      },
                      include: {
                        SmartContractWallet: true,
                        SellerWallet: true,
                        CurrentTransaction: { include: { BlocksWallet: true } },
                      },
                    });
                    if (dbEntry == null) {
                      //transaction is not registered with us
                      return;
                    }
                    if (dbEntry.SmartContractWallet == null) {
                      logger.error(
                        'No smart contract wallet set for purchase request in db',
                        { purchaseRequest: dbEntry },
                      );
                      await prisma.purchaseRequest.update({
                        where: { id: dbEntry.id },
                        data: {
                          NextAction: {
                            create: {
                              requestedAction:
                                PurchasingAction.WaitingForManualAction,
                              errorNote:
                                'No smart contract wallet set for purchase request in db. This is likely an internal error.',
                              errorType: PurchaseErrorType.Unknown,
                              inputHash: decodedNewContract.inputHash,
                            },
                          },
                        },
                      });
                      return;
                    }

                    if (dbEntry.SellerWallet == null) {
                      logger.error(
                        'No seller wallet set for purchase request in db. This seems like an internal error.',
                        { purchaseRequest: dbEntry },
                      );
                      await prisma.purchaseRequest.update({
                        where: { id: dbEntry.id },
                        data: {
                          NextAction: {
                            create: {
                              requestedAction:
                                PurchasingAction.WaitingForManualAction,
                              errorNote:
                                'No seller wallet set for purchase request in db. This seems like an internal error.',
                              errorType: PurchaseErrorType.Unknown,
                              inputHash: decodedNewContract.inputHash,
                            },
                          },
                        },
                      });
                      return;
                    }
                    if (output.reference_script_hash != null) {
                      //no reference script allowed
                      logger.warn(
                        'Reference script hash is not null, this should not be set',
                        { tx: tx.tx.tx_hash },
                      );
                      return;
                    }

                    //We soft ignore those transactions
                    if (
                      decodedNewContract.seller !=
                      dbEntry.SellerWallet.walletVkey
                    ) {
                      logger.warn(
                        'Seller does not match seller in db. This likely is a spoofing attempt.',
                        {
                          purchaseRequest: dbEntry,
                          sender: decodedNewContract.seller,
                          senderDb: dbEntry.SmartContractWallet?.walletVkey,
                        },
                      );
                      return;
                    }

                    if (
                      decodedNewContract.buyer !=
                      dbEntry.SmartContractWallet.walletVkey
                    ) {
                      logger.warn(
                        'Buyer does not match buyer in db. This likely is a spoofing attempt.',
                        {
                          purchaseRequest: dbEntry,
                          buyer: decodedNewContract.buyer,
                          buyerDb: dbEntry.SmartContractWallet?.walletVkey,
                        },
                      );
                      return;
                    }
                    if (
                      decodedNewContract.state ==
                        SmartContractState.RefundRequested ||
                      decodedNewContract.state == SmartContractState.Disputed
                    ) {
                      logger.warn(
                        'Refund was requested. This likely is a spoofing attempt.',
                        {
                          purchaseRequest: dbEntry,
                          state: decodedNewContract.state,
                        },
                      );
                      return;
                    }
                    if (decodedNewContract.resultHash != '') {
                      logger.warn(
                        'Result hash was set. This likely is a spoofing attempt.',
                        {
                          purchaseRequest: dbEntry,
                          resultHash: decodedNewContract.resultHash,
                        },
                      );
                      return;
                    }
                    if (
                      BigInt(decodedNewContract.resultTime) !=
                      dbEntry.submitResultTime
                    ) {
                      logger.warn(
                        'Result time is not the agreed upon time. This likely is a spoofing attempt.',
                        {
                          purchaseRequest: dbEntry,
                          resultTime: decodedNewContract.resultTime,
                          resultTimeDb: dbEntry.submitResultTime,
                        },
                      );
                      return;
                    }
                    if (decodedNewContract.unlockTime < dbEntry.unlockTime) {
                      logger.warn(
                        'Unlock time is before the agreed upon time. This likely is a spoofing attempt.',
                        {
                          purchaseRequest: dbEntry,
                          unlockTime: decodedNewContract.unlockTime,
                          unlockTimeDb: dbEntry.unlockTime,
                        },
                      );
                      return;
                    }
                    if (
                      BigInt(decodedNewContract.externalDisputeUnlockTime) !=
                      dbEntry.externalDisputeUnlockTime
                    ) {
                      logger.warn(
                        'External dispute unlock time is not the agreed upon time. This likely is a spoofing attempt.',
                        {
                          purchaseRequest: dbEntry,
                          externalDisputeUnlockTime:
                            decodedNewContract.externalDisputeUnlockTime,
                          externalDisputeUnlockTimeDb:
                            dbEntry.externalDisputeUnlockTime,
                        },
                      );
                      return;
                    }
                    if (
                      BigInt(decodedNewContract.buyerCooldownTime) != BigInt(0)
                    ) {
                      logger.warn(
                        'Buyer cooldown time is not 0. This likely is a spoofing attempt.',
                        {
                          purchaseRequest: dbEntry,
                          buyerCooldownTime:
                            decodedNewContract.buyerCooldownTime,
                        },
                      );
                      return;
                    }
                    if (
                      BigInt(decodedNewContract.sellerCooldownTime) != BigInt(0)
                    ) {
                      logger.warn(
                        'Seller cooldown time is not 0. This likely is a spoofing attempt.',
                        {
                          purchaseRequest: dbEntry,
                          sellerCooldownTime:
                            decodedNewContract.sellerCooldownTime,
                        },
                      );
                      return;
                    }
                    //TODO: optional check amounts
                    await prisma.purchaseRequest.update({
                      where: { id: dbEntry.id },
                      data: {
                        inputHash: decodedNewContract.inputHash,
                        NextAction: {
                          create: {
                            inputHash: decodedNewContract.inputHash,
                            requestedAction:
                              PurchasingAction.WaitingForExternalAction,
                          },
                        },
                        TransactionHistory:
                          dbEntry.currentTransactionId != null
                            ? { connect: { id: dbEntry.currentTransactionId } }
                            : undefined,
                        CurrentTransaction: {
                          create: {
                            txHash: tx.tx.tx_hash,
                            status: TransactionStatus.Confirmed,
                          },
                        },
                        onChainState: OnChainState.FundsLocked,
                        resultHash: decodedNewContract.resultHash,
                      },
                    });
                    if (
                      dbEntry.currentTransactionId != null &&
                      dbEntry.CurrentTransaction?.BlocksWallet != null
                    ) {
                      await prisma.transaction.update({
                        where: {
                          id: dbEntry.currentTransactionId!,
                        },
                        data: {
                          BlocksWallet: { disconnect: true },
                        },
                      });
                      await prisma.hotWallet.update({
                        where: {
                          id: dbEntry.SmartContractWallet.id,
                        },
                        data: {
                          lockedAt: null,
                        },
                      });
                    }
                  },
                  {
                    isolationLevel:
                      Prisma.TransactionIsolationLevel.Serializable,
                    timeout: 10000,
                    maxWait: 10000,
                  },
                );
                await prisma.$transaction(
                  async (prisma) => {
                    const dbEntry = await prisma.paymentRequest.findUnique({
                      where: {
                        paymentSourceId_blockchainIdentifier: {
                          blockchainIdentifier:
                            decodedNewContract.blockchainIdentifier,
                          paymentSourceId: paymentContract.id,
                        },
                        BuyerWallet: null,
                        NextAction: {
                          requestedAction:
                            PaymentAction.WaitingForExternalAction,
                        },
                      },
                      include: {
                        RequestedFunds: true,
                        BuyerWallet: true,
                        SmartContractWallet: true,
                        CurrentTransaction: { include: { BlocksWallet: true } },
                      },
                    });
                    if (dbEntry == null) {
                      //transaction is not registered with us or duplicated (therefore invalid)
                      return;
                    }
                    if (dbEntry.BuyerWallet != null) {
                      logger.error(
                        'Existing buyer set for payment request in db. This is likely an internal error.',
                        { paymentRequest: dbEntry },
                      );
                      await prisma.paymentRequest.update({
                        where: { id: dbEntry.id },
                        data: {
                          NextAction: {
                            create: {
                              requestedAction:
                                PaymentAction.WaitingForManualAction,
                              errorNote:
                                'Existing buyer set for payment request in db. This is likely an internal error.',
                              errorType: PaymentErrorType.Unknown,
                            },
                          },
                        },
                      });
                      return;
                    }
                    if (dbEntry.SmartContractWallet == null) {
                      logger.error(
                        'No smart contract wallet set for payment request in db. This is likely an internal error.',
                        { paymentRequest: dbEntry },
                      );
                      await prisma.paymentRequest.update({
                        where: { id: dbEntry.id },
                        data: {
                          NextAction: {
                            create: {
                              requestedAction:
                                PaymentAction.WaitingForManualAction,
                              errorNote:
                                'No smart contract wallet set for payment request in db. This is likely an internal error.',
                              errorType: PaymentErrorType.Unknown,
                            },
                          },
                        },
                      });
                      return;
                    }

                    let newAction: PaymentAction =
                      PaymentAction.WaitingForExternalAction;
                    let newState: OnChainState = OnChainState.FundsLocked;
                    const errorNote: string[] = [];
                    if (output.reference_script_hash != null) {
                      const errorMessage =
                        'Reference script hash is not null. This likely is a spoofing attempt.';
                      logger.warn(errorMessage, { tx: tx.tx.tx_hash });
                      newAction = PaymentAction.WaitingForManualAction;
                      newState = OnChainState.FundsOrDatumInvalid;
                      errorNote.push(errorMessage);
                    }
                    if (
                      decodedNewContract.seller !=
                      dbEntry.SmartContractWallet.walletVkey
                    ) {
                      const errorMessage =
                        'Seller does not match seller in db. This likely is a spoofing attempt.';
                      logger.warn(errorMessage, {
                        paymentRequest: dbEntry,
                        seller: decodedNewContract.seller,
                        sellerDb: dbEntry.SmartContractWallet?.walletVkey,
                      });
                      newAction = PaymentAction.WaitingForManualAction;
                      newState = OnChainState.FundsOrDatumInvalid;
                      errorNote.push(errorMessage);
                    }
                    if (
                      decodedNewContract.state ==
                        SmartContractState.RefundRequested ||
                      decodedNewContract.state == SmartContractState.Disputed
                    ) {
                      const errorMessage =
                        'Refund was requested. This likely is a spoofing attempt.';
                      logger.warn(errorMessage, {
                        paymentRequest: dbEntry,
                        state: decodedNewContract.state,
                      });
                      newAction = PaymentAction.WaitingForManualAction;
                      newState = OnChainState.FundsOrDatumInvalid;
                      errorNote.push(errorMessage);
                    }
                    if (decodedNewContract.resultHash != '') {
                      const errorMessage =
                        'Result hash was set. This likely is a spoofing attempt.';
                      logger.warn(errorMessage, {
                        paymentRequest: dbEntry,
                        resultHash: decodedNewContract.resultHash,
                      });
                      newAction = PaymentAction.WaitingForManualAction;
                      newState = OnChainState.FundsOrDatumInvalid;
                      errorNote.push(errorMessage);
                    }
                    if (
                      BigInt(decodedNewContract.resultTime) !=
                      dbEntry.submitResultTime
                    ) {
                      const errorMessage =
                        'Result time is not the agreed upon time. This likely is a spoofing attempt.';
                      logger.warn(errorMessage, {
                        paymentRequest: dbEntry,
                        resultTime: decodedNewContract.resultTime,
                        resultTimeDb: dbEntry.submitResultTime,
                      });
                      newAction = PaymentAction.WaitingForManualAction;
                      newState = OnChainState.FundsOrDatumInvalid;
                      errorNote.push(errorMessage);
                    }
                    if (
                      BigInt(decodedNewContract.unlockTime) !=
                      dbEntry.unlockTime
                    ) {
                      const errorMessage =
                        'Unlock time is before the agreed upon time. This likely is a spoofing attempt.';
                      logger.warn(errorMessage, {
                        paymentRequest: dbEntry,
                        unlockTime: decodedNewContract.unlockTime,
                        unlockTimeDb: dbEntry.unlockTime,
                      });
                      newAction = PaymentAction.WaitingForManualAction;
                      newState = OnChainState.FundsOrDatumInvalid;
                      errorNote.push(errorMessage);
                    }
                    if (
                      BigInt(decodedNewContract.externalDisputeUnlockTime) !=
                      dbEntry.externalDisputeUnlockTime
                    ) {
                      const errorMessage =
                        'External dispute unlock time is not the agreed upon time. This likely is a spoofing attempt.';
                      logger.warn(errorMessage, {
                        paymentRequest: dbEntry,
                        externalDisputeUnlockTime:
                          decodedNewContract.externalDisputeUnlockTime,
                        externalDisputeUnlockTimeDb:
                          dbEntry.externalDisputeUnlockTime,
                      });
                      newAction = PaymentAction.WaitingForManualAction;
                      newState = OnChainState.FundsOrDatumInvalid;
                      errorNote.push(errorMessage);
                    }
                    if (
                      BigInt(decodedNewContract.buyerCooldownTime) != BigInt(0)
                    ) {
                      const errorMessage =
                        'Buyer cooldown time is not 0. This likely is a spoofing attempt.';
                      logger.warn(errorMessage, {
                        paymentRequest: dbEntry,
                        buyerCooldownTime: decodedNewContract.buyerCooldownTime,
                      });
                      newAction = PaymentAction.WaitingForManualAction;
                      newState = OnChainState.FundsOrDatumInvalid;
                      errorNote.push(errorMessage);
                    }
                    if (
                      BigInt(decodedNewContract.sellerCooldownTime) != BigInt(0)
                    ) {
                      const errorMessage =
                        'Seller cooldown time is not 0. This likely is a spoofing attempt.';
                      logger.warn(errorMessage, {
                        paymentRequest: dbEntry,
                        sellerCooldownTime:
                          decodedNewContract.sellerCooldownTime,
                      });
                      newAction = PaymentAction.WaitingForManualAction;
                      newState = OnChainState.FundsOrDatumInvalid;
                      errorNote.push(errorMessage);
                    }

                    const valueMatches = checkPaymentAmountsMatch(
                      dbEntry.RequestedFunds,
                      output.amount,
                    );
                    if (valueMatches == false) {
                      const errorMessage =
                        'Payment amounts do not match. This likely is a spoofing attempt.';
                      logger.warn(errorMessage, {
                        paymentRequest: dbEntry,
                        amounts: output.amount,
                        amountsDb: dbEntry.RequestedFunds,
                      });
                      newAction = PaymentAction.WaitingForManualAction;
                      newState = OnChainState.FundsOrDatumInvalid;
                      errorNote.push(errorMessage);
                    }
                    const paymentCountMatches =
                      dbEntry.RequestedFunds.filter(
                        (x) => x.unit != 'lovelace' && x.unit != '',
                      ).length ==
                      output.amount.filter(
                        (x) => x.unit != 'lovelace' && x.unit != '',
                      ).length;
                    if (paymentCountMatches == false) {
                      const errorMessage =
                        'Token counts do not match. This likely is a spoofing attempt.';
                      logger.warn(errorMessage, {
                        paymentRequest: dbEntry,
                        amounts: output.amount,
                        amountsDb: dbEntry.RequestedFunds,
                      });
                      newAction = PaymentAction.WaitingForManualAction;
                      newState = OnChainState.FundsOrDatumInvalid;
                      errorNote.push(errorMessage);
                    }

                    await prisma.paymentRequest.update({
                      where: { id: dbEntry.id },
                      data: {
                        NextAction: {
                          create: {
                            requestedAction: newAction,
                            errorNote:
                              errorNote.length > 0
                                ? errorNote.join(';\n ')
                                : undefined,
                          },
                        },
                        TransactionHistory:
                          dbEntry.currentTransactionId != null
                            ? { connect: { id: dbEntry.currentTransactionId } }
                            : undefined,
                        CurrentTransaction: {
                          create: {
                            txHash: tx.tx.tx_hash,
                            status: TransactionStatus.Confirmed,
                          },
                        },
                        onChainState: newState,
                        resultHash: decodedNewContract.resultHash,
                        BuyerWallet: {
                          connectOrCreate: {
                            where: {
                              paymentSourceId_walletVkey_type: {
                                paymentSourceId: paymentContract.id,
                                walletVkey: decodedNewContract.buyer,
                                type: WalletType.Buyer,
                              },
                            },
                            create: {
                              walletVkey: decodedNewContract.buyer,
                              type: WalletType.Buyer,
                              PaymentSource: {
                                connect: { id: paymentContract.id },
                              },
                            },
                          },
                        },
                        //no wallet was locked, we do not need to unlock it
                      },
                    });
                  },
                  {
                    isolationLevel:
                      Prisma.TransactionIsolationLevel.Serializable,
                    timeout: 10000,
                    maxWait: 10000,
                  },
                );
              }
              await prisma.paymentSource.update({
                where: { id: paymentContract.id },
                data: { lastIdentifierChecked: tx.tx.tx_hash },
              });
            } else {
              if (redeemers.len() != 1) {
                //invalid transaction
                continue;
              }

              if (valueInputs.length != 1) {
                continue;
              }
              const valueInput = valueInputs[0];
              if (valueInput.reference_script_hash != null) {
                logger.error(
                  'Reference script hash is not null, this should not be allowed on a contract level',
                  { tx: tx.tx.tx_hash },
                );
                //invalid transaction
                continue;
              }

              const inputDatum = valueInput.inline_datum;
              if (inputDatum == null) {
                //invalid transaction
                continue;
              }

              const decodedInputDatum: unknown = deserializeDatum(inputDatum);
              const decodedOldContract =
                decodeV1ContractDatum(decodedInputDatum);
              if (decodedOldContract == null) {
                //invalid transaction
                continue;
              }

              if (valueOutputs.length > 1) {
                continue;
              }

              const outputDatum =
                valueOutputs.length == 1 ? valueOutputs[0].inline_datum : null;
              const decodedOutputDatum =
                outputDatum != null ? deserializeDatum(outputDatum) : null;
              const decodedNewContract =
                decodeV1ContractDatum(decodedOutputDatum);

              const paymentRequest = await prisma.paymentRequest.findUnique({
                where: {
                  paymentSourceId_blockchainIdentifier: {
                    paymentSourceId: paymentContract.id,
                    blockchainIdentifier:
                      decodedOldContract.blockchainIdentifier,
                  },
                },
                include: {
                  BuyerWallet: true,
                  SmartContractWallet: true,
                  RequestedFunds: true,
                  NextAction: true,
                  CurrentTransaction: true,
                  TransactionHistory: true,
                },
              });
              const purchasingRequest = await prisma.purchaseRequest.findUnique(
                {
                  where: {
                    paymentSourceId_blockchainIdentifier: {
                      paymentSourceId: paymentContract.id,
                      blockchainIdentifier:
                        decodedOldContract.blockchainIdentifier,
                    },
                  },
                  include: {
                    SmartContractWallet: true,
                    SellerWallet: true,
                    NextAction: true,
                    CurrentTransaction: true,
                    PaidFunds: true,
                    TransactionHistory: true,
                  },
                },
              );

              if (paymentRequest == null && purchasingRequest == null) {
                //transaction is not registered with us or duplicated (therefore invalid)
                continue;
              }

              let inputTxHashMatchPaymentRequest =
                paymentRequest?.CurrentTransaction?.txHash ==
                valueInput.tx_hash;
              if (
                paymentRequest != null &&
                inputTxHashMatchPaymentRequest == false
              ) {
                //find tx hash in history
                inputTxHashMatchPaymentRequest =
                  paymentRequest?.TransactionHistory.find(
                    (x) => x.txHash == valueInput.tx_hash,
                  ) != null;
                if (inputTxHashMatchPaymentRequest == false) {
                  logger.warn(
                    'Input tx hash does not match payment request tx hash. This likely is a spoofing attempt',
                    {
                      paymentRequest: paymentRequest,
                      txHash: valueInput.tx_hash,
                    },
                  );
                  continue;
                }
                logger.warn(
                  'Input tx hash of checked payment request did not match current status, but was found in the history. This is likely due to a failed transaction.',
                  {
                    paymentRequest: paymentRequest,
                    txHash: valueInput.tx_hash,
                  },
                );
              }
              let inputTxHashMatchPurchasingRequest =
                purchasingRequest?.CurrentTransaction?.txHash ==
                valueInput.tx_hash;
              if (
                purchasingRequest != null &&
                inputTxHashMatchPurchasingRequest == false
              ) {
                //find tx hash in history
                inputTxHashMatchPurchasingRequest =
                  purchasingRequest?.TransactionHistory.find(
                    (x) => x.txHash == valueInput.tx_hash,
                  ) != null;

                if (inputTxHashMatchPurchasingRequest == false) {
                  logger.warn(
                    'Input tx hash does not match purchasing request tx hash. This likely is a spoofing attempt',
                    {
                      purchasingRequest: purchasingRequest,
                      txHash: valueInput.tx_hash,
                    },
                  );
                  continue;
                }
                logger.warn(
                  'Input tx hash of checked purchasing request did not match current status, but was found in the history. This is likely due to a failed transaction.',
                  {
                    purchasingRequest: purchasingRequest,
                    txHash: valueInput.tx_hash,
                  },
                );
              }

              const redeemer = redeemers.get(0);

              const redeemerVersion = JSON.parse(
                redeemer.data().to_json(PlutusDatumSchema.BasicConversions),
              )['constructor'];

              if (
                redeemerVersion != 0 &&
                redeemerVersion != 3 &&
                redeemerVersion != 4 &&
                decodedNewContract == null
              ) {
                //this should not be possible
                logger.error(
                  'Possible invalid state in smart contract detected. tx_hash: ' +
                    tx.tx.tx_hash,
                );
                continue;
              }

              let newState: OnChainState;

              if (redeemerVersion == 0) {
                //Withdraw
                newState = OnChainState.Withdrawn;
              } else if (redeemerVersion == 1) {
                //RequestRefund
                if (
                  decodedNewContract!.resultHash &&
                  decodedNewContract!.resultHash != ''
                ) {
                  newState = OnChainState.Disputed;
                } else {
                  newState = OnChainState.RefundRequested;
                }
              } else if (redeemerVersion == 2) {
                //CancelRefundRequest
                if (decodedNewContract!.resultHash) {
                  newState = OnChainState.ResultSubmitted;
                } else {
                  //Ensure the amounts match, to prevent state change attacks
                  const valueMatches = checkPaymentAmountsMatch(
                    paymentRequest?.RequestedFunds ??
                      purchasingRequest?.PaidFunds ??
                      [],
                    valueOutputs[0].amount,
                  );
                  newState =
                    valueMatches == true
                      ? OnChainState.FundsLocked
                      : OnChainState.FundsOrDatumInvalid;
                }
              } else if (redeemerVersion == 3) {
                //WithdrawRefund
                newState = OnChainState.RefundWithdrawn;
              } else if (redeemerVersion == 4) {
                //WithdrawDisputed
                newState = OnChainState.DisputedWithdrawn;
              } else if (redeemerVersion == 5) {
                //SubmitResult
                if (
                  decodedNewContract!.state ==
                    SmartContractState.RefundRequested ||
                  decodedNewContract!.state == SmartContractState.Disputed
                ) {
                  newState = OnChainState.Disputed;
                } else {
                  newState = OnChainState.ResultSubmitted;
                }
              } else if (redeemerVersion == 6) {
                //AllowRefund
                newState = OnChainState.RefundRequested;
              } else {
                //invalid transaction
                logger.error(
                  'Unexpected redeemer version detected. Possible invalid state in smart contract or bug in the software. tx_hash: ' +
                    tx.tx.tx_hash,
                );
                continue;
              }
              try {
                if (inputTxHashMatchPaymentRequest) {
                  await handlePaymentTransactionCardanoV1(
                    tx.tx.tx_hash,
                    newState,
                    paymentContract.id,
                    decodedOldContract.blockchainIdentifier,
                    decodedNewContract?.resultHash ??
                      decodedOldContract.resultHash,
                    paymentRequest?.NextAction?.requestedAction ??
                      PurchasingAction.None,
                    Number(paymentRequest?.buyerCoolDownTime ?? 0),
                    Number(paymentRequest?.sellerCoolDownTime ?? 0),
                  );
                }
              } catch (error) {
                logger.error('Error handling payment transaction', {
                  error: error,
                });
              }
              try {
                if (inputTxHashMatchPurchasingRequest) {
                  await handlePurchasingTransactionCardanoV1(
                    tx.tx.tx_hash,
                    newState,
                    paymentContract.id,
                    decodedOldContract.blockchainIdentifier,
                    decodedNewContract?.resultHash ??
                      decodedOldContract.resultHash,
                    purchasingRequest?.NextAction?.requestedAction ??
                      PurchasingAction.None,
                    Number(purchasingRequest?.buyerCoolDownTime ?? 0),
                    Number(purchasingRequest?.sellerCoolDownTime ?? 0),
                  );
                }
              } catch (error) {
                logger.error('Error handling purchasing transaction', {
                  error: error,
                });
              }

              await prisma.paymentSource.update({
                where: { id: paymentContract.id },
                data: { lastIdentifierChecked: tx.tx.tx_hash },
              });
            }
          }
        }),
      );

      const failedResults = results.filter((x) => x.status == 'rejected');
      if (failedResults.length > 0) {
        logger.error('Error updating tx data', {
          error: failedResults,
          paymentContract: paymentContracts,
        });
      }
    } catch (error) {
      logger.error('Error checking latest transactions', { error: error });
    } finally {
      const result = await advancedRetry({
        operation: async () => {
          await prisma.paymentSource.updateMany({
            where: { id: { in: paymentContracts.map((x) => x.id) } },
            data: { syncInProgress: false },
          });
        },
        errorResolvers: [
          delayErrorResolver({
            configuration: {
              initialDelayMs: 1000,
              maxDelayMs: 10000,
              backoffMultiplier: 2,
              maxRetries: 3,
            },
          }),
        ],
      });
      if (result.success == false) {
        logger.error('Error updating tx data', {
          error: result.error,
          paymentContract: paymentContracts,
        });
      }
    }
  } catch (error) {
    logger.error('Error checking latest transactions', { error: error });
  } finally {
    //library is strange as we can release from any non-acquired semaphore
    updateMutex.release();
  }
}

async function handlePaymentTransactionCardanoV1(
  tx_hash: string,
  newState: OnChainState,
  paymentContractId: string,
  blockchainIdentifier: string,
  resultHash: string,
  currentAction: PaymentAction,
  buyerCooldownTime: number,
  sellerCooldownTime: number,
) {
  await prisma.$transaction(
    async (prisma) => {
      //we dont need to do sanity checks as the tx hash is unique
      const paymentRequest = await prisma.paymentRequest.findUnique({
        where: {
          paymentSourceId_blockchainIdentifier: {
            paymentSourceId: paymentContractId,
            blockchainIdentifier: blockchainIdentifier,
          },
        },
        include: {
          CurrentTransaction: { include: { BlocksWallet: true } },
        },
      });

      if (paymentRequest == null) {
        //transaction is not registered with us or a payment transaction
        return;
      }

      const newAction = convertNewPaymentActionAndError(
        currentAction,
        newState,
      );

      await prisma.paymentRequest.update({
        where: { id: paymentRequest.id },
        data: {
          NextAction: {
            create: {
              requestedAction: newAction.action,
              errorNote: newAction.errorNote,
              errorType: newAction.errorType,
            },
          },
          TransactionHistory:
            paymentRequest.currentTransactionId != null
              ? { connect: { id: paymentRequest.currentTransactionId } }
              : undefined,
          CurrentTransaction: {
            create: {
              txHash: tx_hash,
              status: TransactionStatus.Confirmed,
            },
          },
          buyerCoolDownTime: buyerCooldownTime,
          sellerCoolDownTime: sellerCooldownTime,
          onChainState: newState,
          resultHash: resultHash,
        },
      });
      if (
        paymentRequest.currentTransactionId != null &&
        paymentRequest.CurrentTransaction?.BlocksWallet != null
      ) {
        await prisma.transaction.update({
          where: {
            id: paymentRequest.currentTransactionId!,
          },
          data: { BlocksWallet: { disconnect: true } },
        });
        await prisma.hotWallet.update({
          where: {
            id: paymentRequest.CurrentTransaction.BlocksWallet.id,
          },
          data: { lockedAt: null },
        });
      }
    },
    {
      isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      timeout: 100000,
      maxWait: 10000,
    },
  );
}

async function handlePurchasingTransactionCardanoV1(
  tx_hash: string,
  newStatus: OnChainState,
  paymentContractId: string,
  blockchainIdentifier: string,
  resultHash: string,
  currentAction: PurchasingAction,
  buyerCooldownTime: number,
  sellerCooldownTime: number,
) {
  await prisma.$transaction(
    async (prisma) => {
      //we dont need to do sanity checks as the tx hash is unique
      const purchasingRequest = await prisma.purchaseRequest.findUnique({
        where: {
          paymentSourceId_blockchainIdentifier: {
            paymentSourceId: paymentContractId,
            blockchainIdentifier: blockchainIdentifier,
          },
        },
        include: {
          CurrentTransaction: { include: { BlocksWallet: true } },
        },
      });

      if (purchasingRequest == null) {
        //transaction is not registered with us as a purchasing transaction
        return;
      }
      const newAction = convertNewPurchasingActionAndError(
        currentAction,
        newStatus,
      );

      await prisma.purchaseRequest.update({
        where: { id: purchasingRequest.id },
        data: {
          inputHash: purchasingRequest.inputHash,
          NextAction: {
            create: {
              inputHash: purchasingRequest.inputHash,
              requestedAction: newAction.action,
              errorNote: newAction.errorNote,
              errorType: newAction.errorType,
            },
          },
          TransactionHistory:
            purchasingRequest.currentTransactionId != null
              ? { connect: { id: purchasingRequest.currentTransactionId } }
              : undefined,
          CurrentTransaction: {
            create: {
              txHash: tx_hash,
              status: TransactionStatus.Confirmed,
            },
          },
          buyerCoolDownTime: buyerCooldownTime,
          sellerCoolDownTime: sellerCooldownTime,
          onChainState: newStatus,
          resultHash: resultHash,
        },
      });
      if (
        purchasingRequest.currentTransactionId != null &&
        purchasingRequest.CurrentTransaction?.BlocksWallet != null
      ) {
        await prisma.transaction.update({
          where: {
            id: purchasingRequest.currentTransactionId!,
          },
          data: { BlocksWallet: { disconnect: true } },
        });
        await prisma.hotWallet.update({
          where: {
            id: purchasingRequest.CurrentTransaction.BlocksWallet.id,
          },
          data: { lockedAt: null },
        });
      }
    },
    {
      isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      timeout: 10000,
      maxWait: 10000,
    },
  );
}

function checkPaymentAmountsMatch(
  expectedAmounts: { unit: string; amount: bigint }[],
  actualAmounts: { unit: string; quantity: string }[],
) {
  return expectedAmounts.every((x) => {
    const existingAmount = actualAmounts.find((y) => y.unit == x.unit);
    if (existingAmount == null) return false;
    //allow for some overpayment to handle min lovelace requirements
    if (x.unit == 'lovelace' || x.unit == '') {
      return x.amount <= BigInt(existingAmount.quantity);
    }
    //require exact match for non-lovelace amounts
    return x.amount == BigInt(existingAmount.quantity);
  });
}

export const cardanoTxHandlerService = {
  checkLatestTransactions,
  checkPaymentAmountsMatch,
};
