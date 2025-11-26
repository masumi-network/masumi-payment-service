import { PaymentSource, PaymentSourceConfig, Prisma } from '@prisma/client';
import { prisma } from '@/utils/db';
import { logger } from '@/utils/logger';
import { BlockFrostAPI } from '@blockfrost/blockfrost-js';
import { convertNetwork } from '@/utils/converter/network-convert';
import { Mutex, MutexInterface, tryAcquire } from 'async-mutex';
import { CONFIG, CONSTANTS } from '@/utils/config';
import { extractOnChainTransactionData } from './util';
import {
  getExtendedTxInformation,
  getTxsFromCardanoAfterSpecificTx,
} from './blockchain';
import {
  updateInitialTransactions,
  updateRolledBackTransaction,
  updateTransaction,
} from './tx';
import { Transaction } from '@emurgo/cardano-serialization-lib-nodejs';

type PaymentSourceWithConfig = PaymentSource & {
  PaymentSourceConfig: PaymentSourceConfig;
};

type ExtendedTxInfo = {
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
};

const mutex = new Mutex();

export async function checkLatestTransactions(
  {
    maxParallelTransactionsExtendedLookup:
      maxParallelTransactionsExtendedLookup = CONSTANTS.DEFAULT_MAX_PARALLEL_TRANSACTIONS_EXTENDED_LOOKUP,
  }: { maxParallelTransactionsExtendedLookup?: number } = {
    maxParallelTransactionsExtendedLookup:
      CONSTANTS.DEFAULT_MAX_PARALLEL_TRANSACTIONS_EXTENDED_LOOKUP,
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
    const paymentContracts = await queryAndLockPaymentSourcesForSync();
    if (paymentContracts == null) return;
    try {
      const results = await Promise.allSettled(
        paymentContracts.map((paymentContract) =>
          processPaymentSource(
            paymentContract,
            maxParallelTransactionsExtendedLookup,
          ),
        ),
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
async function processPaymentSource(
  paymentContract: PaymentSourceWithConfig,
  maxParallelTransactionsExtendedLookup: number,
) {
  const blockfrost = new BlockFrostAPI({
    projectId: paymentContract.PaymentSourceConfig.rpcProviderApiKey,
    network: convertNetwork(paymentContract.network),
  });
  let latestIdentifier = paymentContract.lastIdentifierChecked;

  const { latestTx, rolledBackTx } = await getTxsFromCardanoAfterSpecificTx(
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
    maxParallelTransactionsExtendedLookup,
  );

  for (const tx of txData) {
    if (tx.block.confirmations < CONFIG.BLOCK_CONFIRMATIONS_THRESHOLD) {
      break;
    }

    try {
      await processTransactionData(tx, paymentContract, blockfrost);
    } catch (error) {
      logger.error('Error processing transaction', {
        error: error,
        tx: tx,
      });
      throw error;
    } finally {
      await updateSyncCheckpoint(
        paymentContract,
        tx.tx.tx_hash,
        latestIdentifier,
      );
      latestIdentifier = tx.tx.tx_hash;
    }
  }
}
async function processTransactionData(
  tx: ExtendedTxInfo,
  paymentContract: PaymentSourceWithConfig,
  blockfrost: BlockFrostAPI,
) {
  const extractedData = extractOnChainTransactionData(tx, paymentContract);

  if (extractedData.type == 'Invalid') {
    logger.info('Skipping invalid tx: ', tx.tx.tx_hash, extractedData.error);
    return;
  } else if (extractedData.type == 'Initial') {
    await updateInitialTransactions(
      extractedData.valueOutputs,
      paymentContract,
      tx,
    );
  } else if (extractedData.type == 'Transaction') {
    await updateTransaction(paymentContract, extractedData, blockfrost, tx);
  }
}
async function updateSyncCheckpoint(
  paymentContract: PaymentSourceWithConfig,
  currentTxHash: string,
  previousTxHash: string | null,
) {
  await prisma.paymentSource.update({
    where: { id: paymentContract.id, deletedAt: null },
    data: {
      lastIdentifierChecked: currentTxHash,
    },
  });

  // Separately handle PaymentSourceIdentifiers
  if (previousTxHash != null) {
    await prisma.paymentSourceIdentifiers.upsert({
      where: {
        txHash: previousTxHash,
      },
      update: {
        txHash: previousTxHash,
      },
      create: {
        txHash: previousTxHash,
        paymentSourceId: paymentContract.id,
      },
    });
  }
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

async function queryAndLockPaymentSourcesForSync() {
  return await prisma.$transaction(
    async (prisma) => {
      const paymentContracts = await prisma.paymentSource.findMany({
        where: {
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
                    CONFIG.SYNC_LOCK_TIMEOUT_INTERVAL,
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
      timeout: CONSTANTS.TRANSACTION_WAIT.SERIALIZABLE,
      maxWait: CONSTANTS.TRANSACTION_WAIT.SERIALIZABLE,
    },
  );
}
