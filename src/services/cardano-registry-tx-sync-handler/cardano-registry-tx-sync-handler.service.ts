import {
  RegistrationState,
  TransactionStatus,
} from '@/generated/prisma/client';
import { prisma } from '@/utils/db';
import { logger } from '@/utils/logger';
import { BlockFrostAPI } from '@blockfrost/blockfrost-js';
import { advancedRetryAll, delayErrorResolver } from 'advanced-retry';
import { Mutex, MutexInterface, tryAcquire } from 'async-mutex';
import { getBlockfrostInstance } from '@/utils/blockfrost';

const mutex = new Mutex();

export async function checkRegistryTransactions() {
  let release: MutexInterface.Releaser | null;
  try {
    release = await tryAcquire(mutex).acquire();
  } catch (e) {
    logger.info('Mutex timeout when locking', { error: e });
    return;
  }

  try {
    //only support web3 cardano v1 for now
    const paymentContracts = await getPaymentSourcesForSync();
    if (paymentContracts.length == 0) {
      logger.warn(
        'No payment contracts found, skipping update. It could be that an other instance is already syncing',
      );
      return;
    }

    try {
      const results = await Promise.allSettled(
        paymentContracts.map(async (paymentContract) => {
          const blockfrost = getBlockfrostInstance(
            paymentContract.network,
            paymentContract.PaymentSourceConfig.rpcProviderApiKey,
          );

          const registryRequests = await getRegistrationRequestsToSync(
            paymentContract.id,
          );
          await syncRegistryRequests(registryRequests, blockfrost);
        }),
      );

      const failedResults = results.filter((x) => x.status == 'rejected');
      if (failedResults.length > 0) {
        logger.error('Error updating registry requests', {
          error: failedResults,
          paymentContract: paymentContracts,
        });
      }
    } catch (error) {
      logger.error('Error checking latest transactions', { error: error });
    }
  } catch (error) {
    logger.error('Error checking latest transactions', { error: error });
  } finally {
    release();
  }
}

async function syncRegistryRequests(
  registryRequests: Array<{
    id: string;
    state: RegistrationState;
    CurrentTransaction: {
      BlocksWallet: { id: string } | null;
      txHash: string | null;
    } | null;
    agentIdentifier: string | null;
  }>,
  blockfrost: BlockFrostAPI,
) {
  const results = await advancedRetryAll({
    operations: registryRequests.map((registryRequest) => async () => {
      const owner = await blockfrost.assetsAddresses(
        registryRequest.agentIdentifier!,
        { order: 'desc' },
      );

      if (registryRequest.state == RegistrationState.RegistrationInitiated) {
        if (owner.length >= 1 && owner[0].quantity == '1') {
          if (
            registryRequest.CurrentTransaction == undefined ||
            registryRequest.CurrentTransaction.txHash == null
          ) {
            throw new Error('Registry request has no tx hash');
          }
          const tx = await blockfrost.txs(
            registryRequest.CurrentTransaction.txHash,
          );
          const block = await blockfrost.blocks(tx.block);
          const confirmations = block.confirmations;
          await prisma.registryRequest.update({
            where: { id: registryRequest.id },
            data: {
              state: RegistrationState.RegistrationConfirmed,
              CurrentTransaction: {
                update: {
                  status: TransactionStatus.Confirmed,
                  confirmations: confirmations,
                  fees: BigInt(tx.fees),
                  blockHeight: tx.block_height,
                  blockTime: tx.block_time,
                  outputAmount: JSON.stringify(tx.output_amount),
                  utxoCount: tx.utxo_count,
                  withdrawalCount: tx.withdrawal_count,
                  assetMintOrBurnCount: tx.asset_mint_or_burn_count,
                  redeemerCount: tx.redeemer_count,
                  validContract: tx.valid_contract,
                  BlocksWallet:
                    registryRequest.CurrentTransaction?.BlocksWallet != null
                      ? { disconnect: true }
                      : undefined,
                },
              },
            },
          });
          if (registryRequest.CurrentTransaction?.BlocksWallet != null) {
            await prisma.hotWallet.update({
              where: {
                id: registryRequest.CurrentTransaction.BlocksWallet.id,
                deletedAt: null,
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
        registryRequest.state == RegistrationState.DeregistrationInitiated
      ) {
        if (owner.length == 0 || owner[0].quantity == '0') {
          if (
            registryRequest.CurrentTransaction == undefined ||
            registryRequest.CurrentTransaction.txHash == null
          ) {
            throw new Error('Deregistration request has no tx hash');
          }
          const tx = await blockfrost.txs(
            registryRequest.CurrentTransaction.txHash,
          );
          const block = await blockfrost.blocks(tx.block);
          const confirmations = block.confirmations;
          await prisma.registryRequest.update({
            where: { id: registryRequest.id },
            data: {
              state: RegistrationState.DeregistrationConfirmed,
              CurrentTransaction: {
                update: {
                  status: TransactionStatus.Confirmed,
                  confirmations: confirmations,
                  fees: BigInt(tx.fees),
                  blockHeight: tx.block_height,
                  blockTime: tx.block_time,
                  outputAmount: JSON.stringify(tx.output_amount),
                  utxoCount: tx.utxo_count,
                  withdrawalCount: tx.withdrawal_count,
                  assetMintOrBurnCount: tx.asset_mint_or_burn_count,
                  redeemerCount: tx.redeemer_count,
                  validContract: tx.valid_contract,
                  BlocksWallet:
                    registryRequest.CurrentTransaction?.BlocksWallet != null
                      ? { disconnect: true }
                      : undefined,
                },
              },
            },
          });
          if (registryRequest.CurrentTransaction?.BlocksWallet != null) {
            await prisma.hotWallet.update({
              where: {
                id: registryRequest.CurrentTransaction.BlocksWallet.id,
                deletedAt: null,
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
  results.forEach((x) => {
    if (x.success == false) {
      logger.warn('Failed to update registry request', {
        error: x.error,
      });
    }
  });
}

async function getRegistrationRequestsToSync(paymentContractId: string) {
  return await prisma.registryRequest.findMany({
    where: {
      PaymentSource: {
        id: paymentContractId,
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
}

async function getPaymentSourcesForSync() {
  return await prisma.paymentSource.findMany({
    where: {
      deletedAt: null,
      disableSyncAt: null,
    },
    include: {
      PaymentSourceConfig: true,
    },
  });
}
