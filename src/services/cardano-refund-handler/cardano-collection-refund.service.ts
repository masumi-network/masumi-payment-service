import {
  OnChainState,
  PurchaseErrorType,
  PurchasingAction,
  TransactionStatus,
  Prisma,
} from '@/generated/prisma/client';
import { prisma } from '@/utils/db';
import {
  BlockfrostProvider,
  deserializeDatum,
  SLOT_CONFIG_NETWORK,
  unixTimeToEnclosingSlot,
} from '@meshsdk/core';
import { logger } from '@/utils/logger';
import {
  getPaymentScriptFromPaymentSourceV1,
  smartContractStateEqualsOnChainState,
} from '@/utils/generator/contract-generator';
import { convertNetwork } from '@/utils/converter/network-convert';
import { generateWalletExtended } from '@/utils/generator/wallet-generator';
import { decodeV1ContractDatum } from '@/utils/converter/string-datum-convert';
import { lockAndQueryPurchases } from '@/utils/db/lock-and-query-purchases';
import { errorToString } from '@/utils/converter/error-string-convert';
import { advancedRetryAll, delayErrorResolver } from 'advanced-retry';
import { sortAndLimitUtxos } from '@/utils/utxo';
import { Mutex, MutexInterface, tryAcquire } from 'async-mutex';
import { generateMasumiSmartContractWithdrawTransactionAutomaticFees } from '@/utils/generator/transaction-generator';

type PaymentSourceWithPurchaseRelations = Prisma.PaymentSourceGetPayload<{
  include: {
    PurchaseRequests: {
      include: {
        NextAction: true;
        CurrentTransaction: true;
        PaidFunds: true;
        SellerWallet: true;
        SmartContractWallet: {
          include: {
            Secret: true;
          };
        };
      };
    };
    AdminWallets: true;
    FeeReceiverNetworkWallet: true;
    PaymentSourceConfig: true;
  };
}>;

// Extract PurchaseRequest type from PaymentSource
type PurchaseRequestWithRelations = PaymentSourceWithPurchaseRelations['PurchaseRequests'][number];

const mutex = new Mutex();

async function processSingleRefundCollection(
  request: PurchaseRequestWithRelations,
  paymentContract: PaymentSourceWithPurchaseRelations,
  blockchainProvider: BlockfrostProvider,
  network: 'mainnet' | 'preprod',
): Promise<boolean> {
  if (request.payByTime == null) {
    throw new Error('Pay by time is null, this is deprecated');
  }
  if (request.collateralReturnLovelace == null) {
    throw new Error('Collateral return lovelace is null, this is deprecated');
  }
  if (request.SmartContractWallet == null) throw new Error('Smart contract wallet not found');
  const { wallet, utxos, address } = await generateWalletExtended(
    paymentContract.network,
    paymentContract.PaymentSourceConfig.rpcProviderApiKey,
    request.SmartContractWallet.Secret.encryptedMnemonic,
  );

  if (utxos.length === 0) {
    //this is if the seller wallet is empty
    throw new Error('No UTXOs found in the wallet. Wallet is empty.');
  }

  const { script, smartContractAddress } =
    await getPaymentScriptFromPaymentSourceV1(paymentContract);

  const txHash = request.CurrentTransaction?.txHash;
  if (txHash == null) {
    throw new Error('Transaction hash not found');
  }

  const utxoByHash = await blockchainProvider.fetchUTxOs(txHash);

  const utxo = utxoByHash.find((utxo) => {
    if (utxo.input.txHash != txHash) {
      return false;
    }
    const utxoDatum = utxo.output.plutusData;
    if (!utxoDatum) {
      return false;
    }

    const decodedDatum: unknown = deserializeDatum(utxoDatum);
    const decodedContract = decodeV1ContractDatum(decodedDatum, network);
    if (decodedContract == null) {
      return false;
    }

    return (
      smartContractStateEqualsOnChainState(decodedContract.state, request.onChainState) &&
      decodedContract.buyerVkey == request.SmartContractWallet?.walletVkey &&
      decodedContract.sellerVkey == request.SellerWallet.walletVkey &&
      decodedContract.buyerAddress == request.SmartContractWallet?.walletAddress &&
      decodedContract.sellerAddress == request.SellerWallet.walletAddress &&
      decodedContract.blockchainIdentifier == request.blockchainIdentifier &&
      decodedContract.inputHash == request.inputHash &&
      BigInt(decodedContract.resultTime) == BigInt(request.submitResultTime) &&
      BigInt(decodedContract.unlockTime) == BigInt(request.unlockTime) &&
      BigInt(decodedContract.externalDisputeUnlockTime) ==
        BigInt(request.externalDisputeUnlockTime) &&
      BigInt(decodedContract.collateralReturnLovelace) ==
        BigInt(request.collateralReturnLovelace!) &&
      BigInt(decodedContract.payByTime) == BigInt(request.payByTime!)
    );
  });

  if (!utxo) {
    throw new Error('UTXO not found');
  }

  const utxoDatum = utxo.output.plutusData;
  if (!utxoDatum) {
    throw new Error('No datum found in UTXO');
  }

  const decodedDatum: unknown = deserializeDatum(utxoDatum);
  const decodedContract = decodeV1ContractDatum(decodedDatum, network);
  if (decodedContract == null) {
    throw new Error('Invalid datum');
  }

  const invalidBefore =
    unixTimeToEnclosingSlot(Date.now() - 150000, SLOT_CONFIG_NETWORK[network]) - 1;

  const invalidAfter =
    unixTimeToEnclosingSlot(Date.now() + 150000, SLOT_CONFIG_NETWORK[network]) + 5;

  const limitedFilteredUtxos = sortAndLimitUtxos(utxos, 8000000);
  const collateralUtxo = limitedFilteredUtxos[0];
  if (collateralUtxo == null) {
    throw new Error('Collateral UTXO not found');
  }

  const unsignedTx = await generateMasumiSmartContractWithdrawTransactionAutomaticFees(
    'CollectRefund',
    blockchainProvider,
    network,
    script,
    address,
    utxo,
    collateralUtxo,
    limitedFilteredUtxos,
    {
      collectAssets: utxo.output.amount,
      collectionAddress: address,
    },
    null,
    null,
    invalidBefore,
    invalidAfter,
  );

  const signedTx = await wallet.signTx(unsignedTx);
  await prisma.purchaseRequest.update({
    where: { id: request.id },
    data: {
      ActionHistory: {
        connect: {
          id: request.nextActionId,
        },
      },
      NextAction: {
        create: {
          requestedAction: PurchasingAction.WithdrawRefundInitiated,
          submittedTxHash: null,
        },
      },
      CurrentTransaction: {
        update: {
          txHash: null,
          status: TransactionStatus.Pending,
          BlocksWallet: {
            connect: {
              id: request.SmartContractWallet.id,
            },
          },
        },
      },
      TransactionHistory: {
        connect: {
          id: request.CurrentTransaction!.id,
        },
      },
    },
  });

  //submit the transaction to the blockchain
  const newTxHash = await wallet.submitTx(signedTx);

  await prisma.purchaseRequest.update({
    where: { id: request.id },
    data: {
      CurrentTransaction: {
        update: {
          txHash: newTxHash,
        },
      },
    },
  });

  logger.debug(`Created withdrawal transaction:
                  Tx ID: ${newTxHash}
                  View (after a bit) on https://${
                    network === 'preprod' ? 'preprod.' : ''
                  }cardanoscan.io/transaction/${newTxHash}
                  Smart Contract Address: ${smartContractAddress}
              `);
  return true;
}

export async function collectRefundV1() {
  //const maxBatchSize = 10;

  let release: MutexInterface.Releaser | null;
  try {
    release = await tryAcquire(mutex).acquire();
  } catch (e) {
    logger.info('Mutex timeout when locking', { error: e });
    return;
  }

  try {
    const paymentContractsWithWalletLocked = await lockAndQueryPurchases({
      purchasingAction: PurchasingAction.WithdrawRefundRequested,
      onChainState: {
        in: [OnChainState.RefundRequested, OnChainState.FundsLocked],
      },
      resultHash: null,
      submitResultTime: {
        lte: Date.now() - 1000 * 60 * 10, //add 10 minutes for block time
      },
    });

    await Promise.allSettled(
      paymentContractsWithWalletLocked.map(async (paymentContract) => {
        if (paymentContract.PurchaseRequests.length == 0) return;

        const network = convertNetwork(paymentContract.network);

        logger.info(
          `Collecting ${paymentContract.PurchaseRequests.length} refunds for payment source ${paymentContract.id}`,
        );
        const blockchainProvider = new BlockfrostProvider(
          paymentContract.PaymentSourceConfig.rpcProviderApiKey,
          undefined,
        );

        const purchaseRequests = paymentContract.PurchaseRequests;

        if (purchaseRequests.length == 0) return;
        const results = await advancedRetryAll({
          errorResolvers: [
            delayErrorResolver({
              configuration: {
                maxRetries: 5,
                backoffMultiplier: 5,
                initialDelayMs: 500,
                maxDelayMs: 7500,
              },
            }),
          ],
          operations: purchaseRequests.map(
            (request) => async () =>
              processSingleRefundCollection(request, paymentContract, blockchainProvider, network),
          ),
        });
        let index = 0;
        for (const result of results) {
          const request = purchaseRequests[index];
          if (result.success == false || result.result != true) {
            const error = result.error;
            logger.error(`Error collecting refund ${request.id}`, {
              error: error,
            });
            await prisma.purchaseRequest.update({
              where: { id: request.id },
              data: {
                ActionHistory: {
                  connect: {
                    id: request.nextActionId,
                  },
                },
                NextAction: {
                  create: {
                    requestedAction: PurchasingAction.WaitingForManualAction,
                    errorType: PurchaseErrorType.Unknown,
                    errorNote: 'Collecting refund failed: ' + errorToString(error),
                  },
                },
                SmartContractWallet: {
                  update: {
                    lockedAt: null,
                  },
                },
              },
            });
          }
          index++;
        }
      }),
    );
  } catch (error) {
    //TODO: Release the locked wallets
    logger.error('Error collecting refund', { error: error });
  } finally {
    release();
  }
}
