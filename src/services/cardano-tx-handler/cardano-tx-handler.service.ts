import {
  Network,
  OnChainState,
  PaymentAction,
  PaymentErrorType,
  PaymentType,
  Prisma,
  PurchaseErrorType,
  PurchasingAction,
  TransactionStatus,
  WalletType,
} from '@prisma/client';
import { prisma } from '@/utils/db';
import { logger } from '@/utils/logger';
import { BlockFrostAPI } from '@blockfrost/blockfrost-js';
import {
  PlutusDatumSchema,
  Transaction,
} from '@emurgo/cardano-serialization-lib-nodejs';
import { decodeV1ContractDatum } from '@/utils/converter/string-datum-convert';
import { advancedRetryAll, delayErrorResolver } from 'advanced-retry';
import {
  convertNewPaymentActionAndError,
  convertNewPurchasingActionAndError,
} from '@/utils/logic/state-transitions';
import { convertNetwork } from '@/utils/converter/network-convert';
import { deserializeDatum } from '@meshsdk/core';
import { SmartContractState } from '@/utils/generator/contract-generator';
import { Mutex, MutexInterface, tryAcquire } from 'async-mutex';
import { resolvePaymentKeyHash } from '@meshsdk/core';
import { CONFIG } from '@/utils/config';

const mutex = new Mutex();

const CONSTANTS = {
  DEFAULT_MAX_PARALLEL_TRANSACTIONS: 50,
  MUTEX_TIMEOUT_MINUTES: 3,
  MIN_COLLATERAL_LOVELACE: 1435230n,
  MAX_SMART_CONTRACT_LEVELS: 10,
  TRANSACTION_TIMEOUTS: {
    SERIALIZABLE: 15000,
    PAYMENT_HANDLE: 100000,
    PURCHASING_HANDLE: 10000,
    PAYMENT_SOURCE_LOCK: 10000,
  },
  RETRY_CONFIG: {
    MAX_RETRIES: 5,
    BACKOFF_MULTIPLIER: 2,
    INITIAL_DELAY_MS: 500,
    MAX_DELAY_MS: 15000,
  },
} as const;

type UtxoInput = {
  address: string;
  amount: Array<{ unit: string; quantity: string }>;
  tx_hash: string;
  output_index: number;
  data_hash: string | null;
  inline_datum: string | null;
  reference_script_hash: string | null;
  collateral: boolean;
  reference?: boolean;
};

type UtxoOutput = {
  address: string;
  amount: Array<{ unit: string; quantity: string }>;
  output_index: number;
  data_hash: string | null;
  inline_datum: string | null;
  collateral: boolean;
  reference_script_hash: string | null;
  consumed_by_tx?: string | null;
};

type ExtendedTxInfo = {
  blockTime: number;
  tx: { tx_hash: string };
  block: { confirmations: number };
  utxos: {
    hash: string;
    inputs: UtxoInput[];
    outputs: UtxoOutput[];
  };
  transaction: Transaction;
};

type PaymentContract = {
  id: string;
  network: Network;
  smartContractAddress: string;
  lastIdentifierChecked: string | null;
  PaymentSourceConfig: {
    rpcProviderApiKey: string;
  };
};

type DecodedContract = {
  blockchainIdentifier: string;
  payByTime: bigint;
  resultTime: bigint;
  unlockTime: bigint;
  externalDisputeUnlockTime: bigint;
  buyerVkey: string;
  buyerAddress: string;
  sellerVkey: string;
  sellerAddress: string;
  collateralReturnLovelace: bigint;
  resultHash: string;
  state: SmartContractState;
  buyerCooldownTime: bigint;
  sellerCooldownTime: bigint;
  inputHash: string;
};

type WithdrawnAmount = {
  unit: string;
  quantity: bigint;
};

export async function checkLatestTransactions(
  {
    maxParallelTransactions = CONSTANTS.DEFAULT_MAX_PARALLEL_TRANSACTIONS,
  }: { maxParallelTransactions?: number } = {
    maxParallelTransactions: CONSTANTS.DEFAULT_MAX_PARALLEL_TRANSACTIONS,
  },
) {
  let release: MutexInterface.Releaser | null;
  try {
    release = await tryAcquire(mutex).acquire();
  } catch (e) {
    logger.info('Mutex timeout when locking', { error: e });
    return;
  }

  try {
    //only support web3 cardano v1 for now
    const paymentContracts = await getAndLockPaymentSourcesForSync();
    if (paymentContracts == null) return;
    try {
      const results = await Promise.allSettled(
        paymentContracts.map(async (paymentContract) => {
          const blockfrost = new BlockFrostAPI({
            projectId: paymentContract.PaymentSourceConfig.rpcProviderApiKey,
            network: convertNetwork(paymentContract.network),
          });
          let latestIdentifier = paymentContract.lastIdentifierChecked;

          const { latestTx, rolledBackTx } =
            await getTxsFromCardanoAfterSpecificTx(
              blockfrost,
              paymentContract,
              latestIdentifier,
            );

          if (latestTx.length == 0) {
            logger.info('No new transactions found for payment contract', {
              paymentContractAddress: paymentContract.smartContractAddress,
            });
            return;
          }

          if (rolledBackTx.length > 0) {
            logger.info('Rolled back transactions found for payment contract', {
              paymentContractAddress: paymentContract.smartContractAddress,
            });
            await updateRolledBackTransaction(rolledBackTx);
          }

          const txData = await getExtendedTxInformation(
            latestTx,
            blockfrost,
            maxParallelTransactions,
          );

          for (const tx of txData) {
            if (tx.block.confirmations < CONFIG.BLOCK_CONFIRMATIONS_THRESHOLD) {
              break;
            }

            try {
              const valueInputs = tx.utxos.inputs.filter((x) => {
                return x.address == paymentContract.smartContractAddress;
              });
              const valueOutputs = tx.utxos.outputs.filter((x) => {
                return x.address == paymentContract.smartContractAddress;
              });

              const redeemers = tx.transaction.witness_set().redeemers();

              if (redeemers == null) {
                // TODO: we need a better way to handle the initial transaction as there could be other redeemers

                //payment transaction
                if (valueInputs.length != 0) {
                  //invalid transaction
                  continue;
                }

                await updateInitialTransactions(
                  valueOutputs,
                  paymentContract,
                  tx,
                );
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
                const decodedOldContract = decodeV1ContractDatum(
                  decodedInputDatum,
                  paymentContract.network == Network.Mainnet
                    ? 'mainnet'
                    : 'preprod',
                );
                if (decodedOldContract == null) {
                  //invalid transaction
                  continue;
                }

                if (valueOutputs.length > 1) {
                  continue;
                }

                const outputDatum =
                  valueOutputs.length == 1
                    ? valueOutputs[0].inline_datum
                    : null;
                const decodedOutputDatum: unknown =
                  outputDatum != null ? deserializeDatum(outputDatum) : null;
                const decodedNewContract = decodeV1ContractDatum(
                  decodedOutputDatum,
                  paymentContract.network == Network.Mainnet
                    ? 'mainnet'
                    : 'preprod',
                );

                const paymentRequest = await prisma.paymentRequest.findUnique({
                  where: {
                    paymentSourceId: paymentContract.id,
                    blockchainIdentifier:
                      decodedOldContract.blockchainIdentifier,
                    payByTime: decodedOldContract.payByTime,
                    submitResultTime: decodedOldContract.resultTime,
                    unlockTime: decodedOldContract.unlockTime,
                    externalDisputeUnlockTime:
                      decodedOldContract.externalDisputeUnlockTime,
                    BuyerWallet: {
                      walletVkey: decodedOldContract.buyerVkey,
                      walletAddress: decodedOldContract.buyerAddress,
                    },
                    SmartContractWallet: {
                      walletVkey: decodedOldContract.sellerVkey,
                      walletAddress: decodedOldContract.sellerAddress,
                    },
                  },
                  include: {
                    BuyerWallet: true,
                    SmartContractWallet: { where: { deletedAt: null } },
                    RequestedFunds: true,
                    NextAction: true,
                    CurrentTransaction: true,
                    TransactionHistory: true,
                  },
                });
                const purchasingRequest =
                  await prisma.purchaseRequest.findUnique({
                    where: {
                      paymentSourceId: paymentContract.id,
                      blockchainIdentifier:
                        decodedOldContract.blockchainIdentifier,
                      payByTime: decodedOldContract.payByTime,
                      submitResultTime: decodedOldContract.resultTime,
                      unlockTime: decodedOldContract.unlockTime,
                      externalDisputeUnlockTime:
                        decodedOldContract.externalDisputeUnlockTime,
                      SellerWallet: {
                        walletVkey: decodedOldContract.sellerVkey,
                        walletAddress: decodedOldContract.sellerAddress,
                      },
                      SmartContractWallet: {
                        walletVkey: decodedOldContract.buyerVkey,
                        walletAddress: decodedOldContract.buyerAddress,
                      },
                    },
                    include: {
                      SmartContractWallet: { where: { deletedAt: null } },
                      SellerWallet: true,
                      NextAction: true,
                      CurrentTransaction: true,
                      PaidFunds: true,
                      TransactionHistory: true,
                    },
                  });

                if (paymentRequest == null && purchasingRequest == null) {
                  //transaction is not registered with us or duplicated (therefore invalid)
                  continue;
                }

                let inputTxHashMatchPaymentRequest =
                  paymentRequest?.CurrentTransaction?.txHash == tx.tx.tx_hash;

                let txHistory: string[] | null = null;
                if (
                  paymentRequest != null &&
                  inputTxHashMatchPaymentRequest == false
                ) {
                  //check the other inputs match the payment request
                  txHistory = await getSmartContractInteractionTxHistoryList(
                    blockfrost,
                    paymentContract.smartContractAddress,
                    tx.tx.tx_hash,
                    paymentRequest.CurrentTransaction?.txHash ?? 'no-tx',
                  );
                  //find tx hash in history
                  for (const txHash of txHistory) {
                    if (
                      paymentRequest?.TransactionHistory.find(
                        (x) => x.txHash == txHash,
                      ) != null ||
                      paymentRequest.CurrentTransaction?.txHash == txHash
                    ) {
                      inputTxHashMatchPaymentRequest = true;
                      break;
                    }
                  }

                  if (inputTxHashMatchPaymentRequest == false) {
                    //TODO find all input utxos and see if there are some from the script address
                    logger.warn(
                      'Input tx hash does not match payment request tx hash. This likely is a spoofing attempt',
                      {
                        paymentRequest: paymentRequest,
                        txHash: tx.tx.tx_hash,
                      },
                    );
                  }
                }
                let inputTxHashMatchPurchasingRequest =
                  purchasingRequest?.CurrentTransaction?.txHash ==
                  tx.tx.tx_hash;
                if (
                  purchasingRequest != null &&
                  inputTxHashMatchPurchasingRequest == false
                ) {
                  txHistory = await getSmartContractInteractionTxHistoryList(
                    blockfrost,
                    paymentContract.smartContractAddress,
                    tx.tx.tx_hash,
                    purchasingRequest.CurrentTransaction?.txHash ?? 'no-tx',
                  );

                  //find tx hash in history
                  for (const txHash of txHistory) {
                    if (
                      purchasingRequest?.TransactionHistory.find(
                        (x) => x.txHash == txHash,
                      ) != null ||
                      purchasingRequest.CurrentTransaction?.txHash == txHash
                    ) {
                      inputTxHashMatchPurchasingRequest = true;
                      break;
                    }
                  }

                  if (inputTxHashMatchPurchasingRequest == false) {
                    logger.warn(
                      'Input tx hash does not match purchasing request tx hash. This likely is a spoofing attempt',
                      {
                        purchasingRequest: purchasingRequest,
                        txHash: tx.tx.tx_hash,
                      },
                    );
                  }
                }

                const redeemer = redeemers.get(0);
                const redeemerJson = redeemer
                  .data()
                  .to_json(PlutusDatumSchema.BasicConversions);
                let sellerWithdrawn: Array<{
                  unit: string;
                  quantity: bigint;
                }> = [];
                let buyerWithdrawn: Array<{
                  unit: string;
                  quantity: bigint;
                }> = [];
                const redeemerJsonObject = JSON.parse(redeemerJson) as {
                  constructor: number;
                };

                const redeemerVersion = redeemerJsonObject.constructor;

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
                const valueMatches = checkPaymentAmountsMatch(
                  paymentRequest?.RequestedFunds ??
                    purchasingRequest?.PaidFunds ??
                    [],
                  valueOutputs[0].amount,
                  decodedOldContract.collateralReturnLovelace,
                );

                const newState: OnChainState | null = redeemerToOnChainState(
                  redeemerVersion,
                  decodedNewContract,
                  valueMatches,
                );
                if (!newState) {
                  logger.error(
                    'Unexpected redeemer version detected. Possible invalid state in smart contract or bug in the software. tx_hash: ' +
                      tx.tx.tx_hash,
                  );
                  continue;
                }

                if (newState == OnChainState.DisputedWithdrawn) {
                  sellerWithdrawn = calculateValueChange(
                    tx.utxos.inputs,
                    tx.utxos.outputs,
                    decodedOldContract.sellerVkey,
                  );

                  buyerWithdrawn = calculateValueChange(
                    tx.utxos.inputs,
                    tx.utxos.outputs,
                    decodedOldContract.buyerVkey,
                  );
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
                      Number(decodedNewContract?.buyerCooldownTime ?? 0),
                      Number(decodedNewContract?.sellerCooldownTime ?? 0),
                      sellerWithdrawn,
                      buyerWithdrawn,
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
                      Number(decodedNewContract?.buyerCooldownTime ?? 0),
                      Number(decodedNewContract?.sellerCooldownTime ?? 0),
                      sellerWithdrawn,
                      buyerWithdrawn,
                    );
                  }
                } catch (error) {
                  logger.error('Error handling purchasing transaction', {
                    error: error,
                  });
                }
              }
            } catch (error) {
              logger.error('Error processing transaction', {
                error: error,
                tx: tx,
              });
              throw error;
            } finally {
              await prisma.paymentSource.update({
                where: { id: paymentContract.id, deletedAt: null },
                data: {
                  lastIdentifierChecked: tx.tx.tx_hash,
                },
              });

              // Separately handle PaymentSourceIdentifiers
              if (latestIdentifier != null) {
                await prisma.paymentSourceIdentifiers.upsert({
                  where: {
                    txHash: latestIdentifier,
                  },
                  update: {
                    txHash: latestIdentifier,
                  },
                  create: {
                    txHash: latestIdentifier,
                    paymentSourceId: paymentContract.id,
                  },
                });
              }
              latestIdentifier = tx.tx.tx_hash;
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
      await unlockPaymentSources(paymentContracts.map((x) => x.id));
    }
  } catch (error) {
    logger.error('Error checking latest transactions', { error: error });
  } finally {
    release();
  }
}

function calculateValueChange(
  inputs: Array<{
    address: string;
    amount: Array<{ unit: string; quantity: string }>;
    tx_hash: string;
    output_index: number;
    data_hash: string | null;
    inline_datum: string | null;
    reference_script_hash: string | null;
    collateral: boolean;
    reference?: boolean;
  }>,
  outputs: Array<{
    address: string;
    amount: Array<{ unit: string; quantity: string }>;
    output_index: number;
    data_hash: string | null;
    inline_datum: string | null;
    collateral: boolean;
    reference_script_hash: string | null;
    consumed_by_tx?: string | null;
  }>,
  vkey: string,
) {
  const withdrawnAmount: Array<{ unit: string; quantity: bigint }> = [];
  const inputAmounts = inputs
    .filter((x) => resolvePaymentKeyHash(x.address) == vkey)
    .map((x) => x.amount);
  const outputAmounts = outputs
    .filter((x) => resolvePaymentKeyHash(x.address) == vkey)
    .map((x) => x.amount);

  outputAmounts.forEach((output) => {
    output.forEach((amount) => {
      const outputAmounts = withdrawnAmount.find((x) => {
        return x.unit == amount.unit;
      });
      if (outputAmounts == null) {
        const amountNumber = BigInt(amount.quantity);
        withdrawnAmount.push({
          unit: amount.unit,
          quantity: amountNumber,
        });
      } else {
        outputAmounts.quantity += BigInt(amount.quantity);
      }
    });
  });
  inputAmounts.forEach((input) => {
    input.forEach((amount) => {
      const withdrawnAmounts = withdrawnAmount.find((x) => {
        return x.unit == amount.unit;
      });
      if (withdrawnAmounts == null) {
        const amountNumber = -BigInt(amount.quantity);
        withdrawnAmount.push({
          unit: amount.unit,
          quantity: amountNumber,
        });
      } else {
        withdrawnAmounts.quantity -= BigInt(amount.quantity);
      }
    });
  });
  return withdrawnAmount;
}

async function updateInitialTransactions(
  valueOutputs: Array<{
    address: string;
    amount: Array<{ unit: string; quantity: string }>;
    output_index: number;
    data_hash: string | null;
    inline_datum: string | null;
    collateral: boolean;
    reference_script_hash: string | null;
    consumed_by_tx?: string | null;
  }>,
  paymentContract: {
    id: string;
    network: Network;
  },
  tx: {
    blockTime: number;
    tx: { tx_hash: string };
    block: { confirmations: number };
    utxos: {
      hash: string;
      inputs: Array<{
        address: string;
        amount: Array<{ unit: string; quantity: string }>;
        tx_hash: string;
        output_index: number;
        data_hash: string | null;
        inline_datum: string | null;
        reference_script_hash: string | null;
        collateral: boolean;
        reference?: boolean;
      }>;
      outputs: Array<{
        address: string;
        amount: Array<{ unit: string; quantity: string }>;
        output_index: number;
        data_hash: string | null;
        inline_datum: string | null;
        collateral: boolean;
        reference_script_hash: string | null;
        consumed_by_tx?: string | null;
      }>;
    };
    transaction: Transaction;
  },
) {
  for (const output of valueOutputs) {
    const outputDatum = output.inline_datum;
    if (outputDatum == null) {
      //invalid transaction
      continue;
    }
    const decodedOutputDatum: unknown = deserializeDatum(outputDatum);
    const decodedNewContract = decodeV1ContractDatum(
      decodedOutputDatum,
      paymentContract.network == Network.Mainnet ? 'mainnet' : 'preprod',
    );
    if (decodedNewContract == null) {
      //invalid transaction
      continue;
    }

    await prisma.$transaction(
      async (prisma) => {
        const sellerWallet = await prisma.walletBase.findUnique({
          where: {
            paymentSourceId_walletVkey_walletAddress_type: {
              paymentSourceId: paymentContract.id,
              walletVkey: decodedNewContract.sellerVkey,
              walletAddress: decodedNewContract.sellerAddress,
              type: WalletType.Seller,
            },
          },
        });
        if (sellerWallet == null) {
          return;
        }

        const dbEntry = await prisma.purchaseRequest.findUnique({
          where: {
            blockchainIdentifier: decodedNewContract.blockchainIdentifier,
            paymentSourceId: paymentContract.id,
            NextAction: {
              requestedAction: PurchasingAction.FundsLockingInitiated,
            },
          },
          include: {
            SmartContractWallet: { where: { deletedAt: null } },
            SellerWallet: true,
            CurrentTransaction: {
              include: { BlocksWallet: true },
            },
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
                  requestedAction: PurchasingAction.WaitingForManualAction,
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
                  requestedAction: PurchasingAction.WaitingForManualAction,
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
          decodedNewContract.sellerVkey != dbEntry.SellerWallet.walletVkey ||
          decodedNewContract.sellerAddress != dbEntry.SellerWallet.walletAddress
        ) {
          logger.warn(
            'Seller does not match seller in db. This likely is a spoofing attempt.',
            {
              purchaseRequest: dbEntry,
              sender: decodedNewContract.sellerVkey,
              senderAddress: decodedNewContract.sellerAddress,
              senderDb: dbEntry.SmartContractWallet?.walletVkey,
              senderDbAddress: dbEntry.SmartContractWallet?.walletAddress,
            },
          );
          return;
        }
        if (
          tx.utxos.inputs.find(
            (x) => x.address == decodedNewContract.buyerAddress,
          ) == null
        ) {
          logger.warn(
            'Buyer address not found in inputs, this likely is a spoofing attempt.',
            {
              purchaseRequest: dbEntry,
              buyerAddress: decodedNewContract.buyerAddress,
            },
          );
          return;
        }

        if (
          BigInt(decodedNewContract.collateralReturnLovelace) !=
          dbEntry.collateralReturnLovelace
        ) {
          logger.warn(
            'Collateral return lovelace does not match collateral return lovelace in db. This likely is a spoofing attempt.',
            {
              purchaseRequest: dbEntry,
              collateralReturnLovelace:
                decodedNewContract.collateralReturnLovelace,
              collateralReturnLovelaceDb: dbEntry.collateralReturnLovelace,
            },
          );
          return;
        }

        if (BigInt(decodedNewContract.payByTime) != dbEntry.payByTime) {
          logger.warn(
            'Pay by time does not match pay by time in db. This likely is a spoofing attempt.',
            { purchaseRequest: dbEntry },
          );
          return;
        }

        const blockTime = tx.blockTime;
        if (blockTime * 1000 > decodedNewContract.payByTime) {
          logger.warn(
            'Block time is after pay by time. This is a timed out purchase.',
            {
              purchaseRequest: dbEntry,
              blockTime: blockTime * 1000,
              payByTime: decodedNewContract.payByTime,
            },
          );
          return;
        }

        if (
          decodedNewContract.buyerVkey !=
            dbEntry.SmartContractWallet.walletVkey ||
          decodedNewContract.buyerAddress !=
            dbEntry.SmartContractWallet.walletAddress
        ) {
          logger.warn(
            'Buyer does not match buyer in db. This likely is a spoofing attempt.',
            {
              purchaseRequest: dbEntry,
              buyer: decodedNewContract.buyerVkey,
              buyerAddress: decodedNewContract.buyerAddress,
              buyerDb: dbEntry.SmartContractWallet?.walletVkey,
              buyerDbAddress: dbEntry.SmartContractWallet?.walletAddress,
            },
          );
          return;
        }
        if (
          decodedNewContract.state == SmartContractState.RefundRequested ||
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
        if (BigInt(decodedNewContract.resultTime) != dbEntry.submitResultTime) {
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
              externalDisputeUnlockTimeDb: dbEntry.externalDisputeUnlockTime,
            },
          );
          return;
        }
        if (BigInt(decodedNewContract.buyerCooldownTime) != BigInt(0)) {
          logger.warn(
            'Buyer cooldown time is not 0. This likely is a spoofing attempt.',
            {
              purchaseRequest: dbEntry,
              buyerCooldownTime: decodedNewContract.buyerCooldownTime,
            },
          );
          return;
        }
        if (BigInt(decodedNewContract.sellerCooldownTime) != BigInt(0)) {
          logger.warn(
            'Seller cooldown time is not 0. This likely is a spoofing attempt.',
            {
              purchaseRequest: dbEntry,
              sellerCooldownTime: decodedNewContract.sellerCooldownTime,
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
                requestedAction: PurchasingAction.WaitingForExternalAction,
              },
            },
            TransactionHistory:
              dbEntry.currentTransactionId != null
                ? {
                    connect: { id: dbEntry.currentTransactionId },
                  }
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
              id: dbEntry.currentTransactionId,
            },
            data: {
              BlocksWallet: { disconnect: true },
            },
          });
          await prisma.hotWallet.update({
            where: {
              id: dbEntry.SmartContractWallet.id,
              deletedAt: null,
            },
            data: {
              lockedAt: null,
            },
          });
        }
      },
      {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        timeout: 15000,
        maxWait: 15000,
      },
    );
    await prisma.$transaction(
      async (prisma) => {
        const dbEntry = await prisma.paymentRequest.findUnique({
          where: {
            blockchainIdentifier: decodedNewContract.blockchainIdentifier,
            paymentSourceId: paymentContract.id,
            BuyerWallet: null,
            NextAction: {
              requestedAction: PaymentAction.WaitingForExternalAction,
            },
          },
          include: {
            RequestedFunds: true,
            BuyerWallet: true,
            SmartContractWallet: { where: { deletedAt: null } },
            CurrentTransaction: {
              include: { BlocksWallet: true },
            },
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
                  requestedAction: PaymentAction.WaitingForManualAction,
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
                  requestedAction: PaymentAction.WaitingForManualAction,
                  errorNote:
                    'No smart contract wallet set for payment request in db. This is likely an internal error.',
                  errorType: PaymentErrorType.Unknown,
                },
              },
            },
          });
          return;
        }

        let newAction: PaymentAction = PaymentAction.WaitingForExternalAction;
        let newState: OnChainState = OnChainState.FundsLocked;
        const errorNote: string[] = [];
        if (
          tx.utxos.inputs.find(
            (x) => x.address == decodedNewContract.buyerAddress,
          ) == null
        ) {
          logger.warn(
            'Buyer address not found in inputs, this likely is a spoofing attempt.',
            {
              paymentRequest: dbEntry,
              buyerAddress: decodedNewContract.buyerAddress,
            },
          );
          return;
        }
        if (BigInt(decodedNewContract.payByTime) != dbEntry.payByTime) {
          const errorMessage =
            'Pay by time does not match pay by time in db. This likely is a spoofing attempt.';
          logger.warn(errorMessage, {
            paymentRequest: dbEntry,
            payByTime: decodedNewContract.payByTime,
            payByTimeDb: dbEntry.payByTime,
          });
          newAction = PaymentAction.WaitingForManualAction;
          newState = OnChainState.FundsOrDatumInvalid;
          errorNote.push(errorMessage);
        }
        const blockTime = tx.blockTime;
        if (blockTime * 1000 > decodedNewContract.payByTime) {
          const errorMessage =
            'Block time is after pay by time. This is a timed out purchase.';
          logger.warn(errorMessage, {
            paymentRequest: dbEntry,
            blockTime: blockTime * 1000,
            payByTime: decodedNewContract.payByTime,
          });
          newAction = PaymentAction.WaitingForManualAction;
          newState = OnChainState.FundsOrDatumInvalid;
          errorNote.push(errorMessage);
        }

        if (output.reference_script_hash != null) {
          const errorMessage =
            'Reference script hash is not null. This likely is a spoofing attempt.';
          logger.warn(errorMessage, { tx: tx.tx.tx_hash });
          newAction = PaymentAction.WaitingForManualAction;
          newState = OnChainState.FundsOrDatumInvalid;
          errorNote.push(errorMessage);
        }
        if (
          decodedNewContract.sellerVkey !=
            dbEntry.SmartContractWallet.walletVkey ||
          decodedNewContract.sellerAddress !=
            dbEntry.SmartContractWallet.walletAddress
        ) {
          const errorMessage =
            'Seller does not match seller in db. This likely is a spoofing attempt.';
          logger.warn(errorMessage, {
            paymentRequest: dbEntry,
            seller: decodedNewContract.sellerVkey,
            sellerAddress: decodedNewContract.sellerAddress,
            sellerDb: dbEntry.SmartContractWallet?.walletVkey,
            sellerDbAddress: dbEntry.SmartContractWallet?.walletAddress,
          });
          newAction = PaymentAction.WaitingForManualAction;
          newState = OnChainState.FundsOrDatumInvalid;
          errorNote.push(errorMessage);
        }
        if (
          decodedNewContract.state == SmartContractState.RefundRequested ||
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
        if (BigInt(decodedNewContract.resultTime) != dbEntry.submitResultTime) {
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
        if (BigInt(decodedNewContract.unlockTime) != dbEntry.unlockTime) {
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
            externalDisputeUnlockTimeDb: dbEntry.externalDisputeUnlockTime,
          });
          newAction = PaymentAction.WaitingForManualAction;
          newState = OnChainState.FundsOrDatumInvalid;
          errorNote.push(errorMessage);
        }
        if (BigInt(decodedNewContract.buyerCooldownTime) != BigInt(0)) {
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
        if (BigInt(decodedNewContract.sellerCooldownTime) != BigInt(0)) {
          const errorMessage =
            'Seller cooldown time is not 0. This likely is a spoofing attempt.';
          logger.warn(errorMessage, {
            paymentRequest: dbEntry,
            sellerCooldownTime: decodedNewContract.sellerCooldownTime,
          });
          newAction = PaymentAction.WaitingForManualAction;
          newState = OnChainState.FundsOrDatumInvalid;
          errorNote.push(errorMessage);
        }

        const valueMatches = checkPaymentAmountsMatch(
          dbEntry.RequestedFunds,
          output.amount,
          decodedNewContract.collateralReturnLovelace,
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
          dbEntry.RequestedFunds.filter((x) => x.unit != '').length ==
          output.amount.filter((x) => x.unit != '').length;
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
            collateralReturnLovelace:
              decodedNewContract.collateralReturnLovelace,
            NextAction: {
              create: {
                requestedAction: newAction,
                errorNote:
                  errorNote.length > 0 ? errorNote.join(';\n ') : undefined,
              },
            },
            TransactionHistory:
              dbEntry.currentTransactionId != null
                ? {
                    connect: { id: dbEntry.currentTransactionId },
                  }
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
                  paymentSourceId_walletVkey_walletAddress_type: {
                    paymentSourceId: paymentContract.id,
                    walletVkey: decodedNewContract.buyerVkey,
                    walletAddress: decodedNewContract.buyerAddress,
                    type: WalletType.Buyer,
                  },
                },
                create: {
                  walletVkey: decodedNewContract.buyerVkey,
                  walletAddress: decodedNewContract.buyerAddress,
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
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        timeout: 15000,
        maxWait: 15000,
      },
    );
  }
}

async function updateRolledBackTransaction(
  rolledBackTx: Array<{ tx_hash: string }>,
) {
  for (const tx of rolledBackTx) {
    const foundTransaction = await prisma.transaction.findMany({
      where: {
        txHash: tx.tx_hash,
      },
      include: {
        PaymentRequestCurrent: true,
        PaymentRequestHistory: true,
        PurchaseRequestCurrent: true,
        PurchaseRequestHistory: true,
        BlocksWallet: true,
      },
    });
    for (const transaction of foundTransaction) {
      await prisma.transaction.update({
        where: { id: transaction.id },
        data: {
          status: TransactionStatus.RolledBack,
          BlocksWallet: transaction.BlocksWallet
            ? { disconnect: true }
            : undefined,
        },
      });
      if (transaction.BlocksWallet != null) {
        await prisma.hotWallet.update({
          where: { id: transaction.BlocksWallet.id },
          data: {
            lockedAt: null,
          },
        });
      }

      //TODO: automatically resync the transaction
      if (
        transaction.PaymentRequestCurrent ||
        transaction.PaymentRequestHistory
      ) {
        await prisma.paymentRequest.update({
          where: {
            id:
              transaction.PaymentRequestCurrent?.id ??
              transaction.PaymentRequestHistory!.id,
          },
          data: {
            NextAction: {
              upsert: {
                update: {
                  requestedAction: PaymentAction.WaitingForManualAction,
                  errorNote:
                    'Rolled back transaction detected. Please check the transaction and manually resolve the issue.',
                  errorType: PaymentErrorType.Unknown,
                },
                create: {
                  requestedAction: PaymentAction.WaitingForManualAction,
                  errorNote:
                    'Rolled back transaction detected. Please check the transaction and manually resolve the issue.',
                  errorType: PaymentErrorType.Unknown,
                },
              },
            },
          },
        });
      }
      if (
        transaction.PurchaseRequestCurrent ||
        transaction.PurchaseRequestHistory
      ) {
        await prisma.purchaseRequest.update({
          where: {
            id:
              transaction.PurchaseRequestCurrent?.id ??
              transaction.PurchaseRequestHistory!.id,
          },
          data: {
            NextAction: {
              upsert: {
                update: {
                  requestedAction: PurchasingAction.WaitingForManualAction,
                  errorNote:
                    'Rolled back transaction detected. Please check the transaction and manually resolve the issue.',
                  errorType: PurchaseErrorType.Unknown,
                },
                create: {
                  requestedAction: PurchasingAction.WaitingForManualAction,
                  errorNote:
                    'Rolled back transaction detected. Please check the transaction and manually resolve the issue.',
                  errorType: PurchaseErrorType.Unknown,
                  inputHash:
                    transaction.PurchaseRequestCurrent?.inputHash ??
                    transaction.PurchaseRequestHistory!.inputHash,
                },
              },
            },
          },
        });
      }
    }
  }
}

async function getExtendedTxInformation(
  latestTxs: Array<{ tx_hash: string; block_time: number }>,
  blockfrost: BlockFrostAPI,
  maxTransactionToProcessInParallel: number,
) {
  const batchCount = Math.ceil(
    latestTxs.length / maxTransactionToProcessInParallel,
  );
  const txData: Array<{
    blockTime: number;
    tx: { tx_hash: string };
    block: { confirmations: number };
    utxos: {
      hash: string;
      inputs: Array<{
        address: string;
        amount: Array<{ unit: string; quantity: string }>;
        tx_hash: string;
        output_index: number;
        data_hash: string | null;
        inline_datum: string | null;
        reference_script_hash: string | null;
        collateral: boolean;
        reference?: boolean;
      }>;
      outputs: Array<{
        address: string;
        amount: Array<{ unit: string; quantity: string }>;
        output_index: number;
        data_hash: string | null;
        inline_datum: string | null;
        collateral: boolean;
        reference_script_hash: string | null;
        consumed_by_tx?: string | null;
      }>;
    };
    transaction: Transaction;
  }> = [];
  for (let i = 0; i < batchCount; i++) {
    const txBatch = latestTxs.slice(
      i * maxTransactionToProcessInParallel,
      Math.min((i + 1) * maxTransactionToProcessInParallel, latestTxs.length),
    );

    const txDataBatch = await advancedRetryAll({
      operations: txBatch.map((tx) => async () => {
        const txDetails = await blockfrost.txs(tx.tx_hash);
        let block: { confirmations: number } = { confirmations: 0 };
        if (CONFIG.BLOCK_CONFIRMATIONS_THRESHOLD > 0) {
          block = await blockfrost.blocks(txDetails.block);
        }

        const cbor = await blockfrost.txsCbor(tx.tx_hash);
        const utxos = await blockfrost.txsUtxos(tx.tx_hash);

        const transaction = Transaction.from_bytes(
          Buffer.from(cbor.cbor, 'hex'),
        );
        return {
          tx: tx,
          block: block,
          utxos: utxos,
          transaction: transaction,
          blockTime: tx.block_time,
        };
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

  //sort by smallest block time first
  txData.sort((a, b) => {
    return a.blockTime - b.blockTime;
  });
  return txData;
}

async function getTxsFromCardanoAfterSpecificTx(
  blockfrost: BlockFrostAPI,
  paymentContract: {
    smartContractAddress: string;
  },
  latestIdentifier: string | null,
) {
  let latestTx: Array<{ tx_hash: string; block_time: number }> = [];
  let foundTx = -1;
  let index = 0;
  let rolledBackTx: Array<{ tx_hash: string }> = [];
  do {
    index++;
    const txs = await blockfrost.addressesTransactions(
      paymentContract.smartContractAddress,
      { page: index, order: 'desc' },
    );
    if (txs.length == 0) {
      if (latestTx.length == 0) {
        logger.warn('No transactions found for payment contract', {
          paymentContractAddress: paymentContract.smartContractAddress,
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
    } else if (latestIdentifier != null) {
      //if not found we assume a rollback happened and need to check all previous txs
      for (let i = 0; i < txs.length; i++) {
        const exists = await prisma.paymentSourceIdentifiers.findUnique({
          where: {
            txHash: txs[i].tx_hash,
            PaymentSource: {
              smartContractAddress: paymentContract.smartContractAddress,
            },
          },
        });
        if (exists != null) {
          //get newer txs from db
          const newerThanRollbackTxs =
            await prisma.paymentSourceIdentifiers.findMany({
              where: {
                createdAt: {
                  gte: exists.createdAt,
                },
                PaymentSource: {
                  smartContractAddress: paymentContract.smartContractAddress,
                },
              },
              select: {
                txHash: true,
              },
            });
          rolledBackTx = [
            ...newerThanRollbackTxs.map((x) => {
              return {
                tx_hash: x.txHash,
              };
            }),
            { tx_hash: latestIdentifier },
          ].filter(
            (x) => latestTx.findIndex((y) => y.tx_hash == x.tx_hash) == -1,
          );
          rolledBackTx = rolledBackTx.reverse();

          const foundTxIndex = latestTx.findIndex(
            (x) => x.tx_hash == txs[i].tx_hash,
          );
          foundTx = foundTxIndex;
          latestTx = latestTx.slice(0, foundTxIndex);
          break;
        }
      }
    }
  } while (foundTx == -1);

  //invert to get oldest first
  latestTx = latestTx.reverse();
  return { latestTx, rolledBackTx };
}

async function unlockPaymentSources(paymentContractIds: string[]) {
  try {
    await prisma.paymentSource.updateMany({
      where: {
        id: { in: paymentContractIds },
      },
      data: { syncInProgress: false },
    });
  } catch (error) {
    logger.error('Error unlocking payment sources', { error: error });
  }
}

async function getAndLockPaymentSourcesForSync() {
  return await prisma.$transaction(
    async (prisma) => {
      const paymentContracts = await prisma.paymentSource.findMany({
        where: {
          paymentType: PaymentType.Web3CardanoV1,
          deletedAt: null,
          disableSyncAt: null,
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
        where: {
          id: { in: paymentContracts.map((x) => x.id) },
          deletedAt: null,
        },
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
  sellerWithdrawn: Array<{ unit: string; quantity: bigint }>,
  buyerWithdrawn: Array<{ unit: string; quantity: bigint }>,
) {
  await prisma.$transaction(
    async (prisma) => {
      //we dont need to do sanity checks as the tx hash is unique
      const paymentRequest = await prisma.paymentRequest.findUnique({
        where: {
          paymentSourceId: paymentContractId,
          blockchainIdentifier: blockchainIdentifier,
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
          WithdrawnForSeller: sellerWithdrawn
            ? {
                createMany: {
                  data: sellerWithdrawn.map((sw) => {
                    return { unit: sw.unit, amount: sw.quantity };
                  }),
                },
              }
            : undefined,
          WithdrawnForBuyer: buyerWithdrawn
            ? {
                createMany: {
                  data: buyerWithdrawn.map((bw) => {
                    return { unit: bw.unit, amount: bw.quantity };
                  }),
                },
              }
            : undefined,
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
            id: paymentRequest.currentTransactionId,
          },
          data: { BlocksWallet: { disconnect: true } },
        });
        await prisma.hotWallet.update({
          where: {
            id: paymentRequest.CurrentTransaction.BlocksWallet.id,
            deletedAt: null,
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
  sellerWithdrawn: Array<{ unit: string; quantity: bigint }>,
  buyerWithdrawn: Array<{ unit: string; quantity: bigint }>,
) {
  await prisma.$transaction(
    async (prisma) => {
      //we dont need to do sanity checks as the tx hash is unique
      const purchasingRequest = await prisma.purchaseRequest.findUnique({
        where: {
          paymentSourceId: paymentContractId,
          blockchainIdentifier: blockchainIdentifier,
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
          WithdrawnForSeller: sellerWithdrawn
            ? {
                createMany: {
                  data: sellerWithdrawn.map((sw) => {
                    return { unit: sw.unit, amount: sw.quantity };
                  }),
                },
              }
            : undefined,
          WithdrawnForBuyer: buyerWithdrawn
            ? {
                createMany: {
                  data: buyerWithdrawn.map((bw) => {
                    return { unit: bw.unit, amount: bw.quantity };
                  }),
                },
              }
            : undefined,
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
            id: purchasingRequest.currentTransactionId,
          },
          data: { BlocksWallet: { disconnect: true } },
        });
        await prisma.hotWallet.update({
          where: {
            id: purchasingRequest.CurrentTransaction.BlocksWallet.id,
            deletedAt: null,
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
  expectedAmounts: Array<{ unit: string; amount: bigint }>,
  actualAmounts: Array<{ unit: string; quantity: string }>,
  collateralReturn: bigint,
) {
  if (collateralReturn < 0n) {
    return false;
  }
  if (collateralReturn > 0n && collateralReturn < 1435230n) {
    return false;
  }
  return expectedAmounts.every((x) => {
    if (x.unit.toLowerCase() == 'lovelace') {
      x.unit = '';
    }
    const existingAmount = actualAmounts.find((y) => {
      if (y.unit.toLowerCase() == 'lovelace') {
        y.unit = '';
      }
      return y.unit == x.unit;
    });
    if (existingAmount == null) return false;
    //allow for some overpayment to handle min lovelace requirements
    if (x.unit == '') {
      return x.amount <= BigInt(existingAmount.quantity) - collateralReturn;
    }
    //require exact match for non-lovelace amounts
    return x.amount == BigInt(existingAmount.quantity);
  });
}

//returns all tx hashes that are part of the smart contract interaction, excluding the initial purchase tx hash
async function getSmartContractInteractionTxHistoryList(
  blockfrost: BlockFrostAPI,
  scriptAddress: string,
  txHash: string,
  lastTxHash: string,
  maxLevels: number = 10,
) {
  let remainingLevels = maxLevels;
  let hashToCheck = txHash;
  const txHashes = [];
  while (remainingLevels > 0) {
    const tx = await blockfrost.txsUtxos(hashToCheck);
    const inputUtxos = tx.inputs.filter((x) =>
      x.address.startsWith(scriptAddress),
    );
    const outputUtxos = tx.outputs.filter((x) =>
      x.address.startsWith(scriptAddress),
    );
    if (inputUtxos.length != 1) {
      if (inputUtxos.find((x) => x.tx_hash == lastTxHash) != null) {
        txHashes.push(lastTxHash);
      }
      break;
    }
    txHashes.push(...inputUtxos.map((x) => x.tx_hash));
    if (txHashes.find((x) => x == lastTxHash) != null) {
      break;
    }
    if (outputUtxos.length > 1) {
      return [];
    }
    hashToCheck = inputUtxos[0].tx_hash;
    remainingLevels--;
  }
  return [...new Set(txHashes)];
}
function redeemerToOnChainState(
  redeemerVersion: number,
  decodedNewContract: { resultHash: string; state: SmartContractState } | null,
  valueMatches: boolean,
) {
  if (redeemerVersion == 0) {
    //Withdraw
    return OnChainState.Withdrawn;
  } else if (redeemerVersion == 1) {
    //RequestRefund
    if (decodedNewContract?.resultHash && decodedNewContract.resultHash != '') {
      return OnChainState.Disputed;
    } else {
      return OnChainState.RefundRequested;
    }
  } else if (redeemerVersion == 2) {
    //CancelRefundRequest
    if (decodedNewContract?.resultHash != '') {
      return OnChainState.ResultSubmitted;
    } else {
      //Ensure the amounts match, to prevent state change attacks

      return valueMatches == true
        ? OnChainState.FundsLocked
        : OnChainState.FundsOrDatumInvalid;
    }
  } else if (redeemerVersion == 3) {
    //WithdrawRefund
    return OnChainState.RefundWithdrawn;
  } else if (redeemerVersion == 4) {
    //WithdrawDisputed
    return OnChainState.DisputedWithdrawn;
  } else if (redeemerVersion == 5) {
    //SubmitResult
    if (
      decodedNewContract?.state == SmartContractState.RefundRequested ||
      decodedNewContract?.state == SmartContractState.Disputed
    ) {
      return OnChainState.Disputed;
    } else {
      return OnChainState.ResultSubmitted;
    }
  } else if (redeemerVersion == 6) {
    //AllowRefund
    return OnChainState.RefundRequested;
  } else {
    //invalid transaction
    return null;
  }
}
