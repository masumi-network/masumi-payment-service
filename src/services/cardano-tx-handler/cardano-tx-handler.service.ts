import { PaymentType, Prisma } from '@prisma/client';
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

const mutex = new Mutex();

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
    const paymentContracts = await queryAndLockPaymentSourcesForSync();
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
              const extractedData = extractOnChainTransactionData(
                tx,
                paymentContract,
              );

              if (extractedData.type == 'Invalid') {
                logger.info(
                  'Skipping invalid tx: ',
                  tx.tx.tx_hash,
                  extractedData.error,
                );
                continue;
              } else if (extractedData.type == 'Initial') {
                await updateInitialTransactions(
                  extractedData.valueOutputs,
                  paymentContract,
                  tx,
                );
              } else if (extractedData.type == 'Transaction') {
                await updateTransaction(
                  paymentContract,
                  extractedData,
                  blockfrost,
                  tx,
                );
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
