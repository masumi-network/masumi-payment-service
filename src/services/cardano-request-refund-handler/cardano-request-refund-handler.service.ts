import {
  PurchasingAction,
  TransactionStatus,
  PurchaseErrorType,
  Prisma,
} from '@prisma/client';
import { prisma } from '@/utils/db';
import {
  BlockfrostProvider,
  deserializeDatum,
  SLOT_CONFIG_NETWORK,
  unixTimeToEnclosingSlot,
} from '@meshsdk/core';
import { logger } from '@/utils/logger';
import {
  getDatumFromBlockchainIdentifier,
  getPaymentScriptFromPaymentSourceV1,
  SmartContractState,
  smartContractStateEqualsOnChainState,
} from '@/utils/generator/contract-generator';
import { convertNetwork } from '@/utils/converter/network-convert';
import { generateWalletExtended } from '@/utils/generator/wallet-generator';
import {
  decodeV1ContractDatum,
  newCooldownTime,
} from '@/utils/converter/string-datum-convert';
import { lockAndQueryPurchases } from '@/utils/db/lock-and-query-purchases';
import { errorToString } from '@/utils/converter/error-string-convert';
import { advancedRetryAll, delayErrorResolver } from 'advanced-retry';
import { sortAndLimitUtxos } from '@/utils/utxo';
import { Mutex, MutexInterface, tryAcquire } from 'async-mutex';
import { generateMasumiSmartContractInteractionTransactionAutomaticFees } from '@/utils/generator/transaction-generator';

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
type PurchaseRequestWithRelations =
  PaymentSourceWithPurchaseRelations['PurchaseRequests'][number];

const mutex = new Mutex();

async function processSinglePurchaseRequest(
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
  const purchasingWallet = request.SmartContractWallet;
  if (purchasingWallet == null) throw new Error('Purchasing wallet not found');
  const encryptedSecret = purchasingWallet.Secret.encryptedMnemonic;

  const { wallet, utxos, address } = await generateWalletExtended(
    paymentContract.network,
    paymentContract.PaymentSourceConfig.rpcProviderApiKey,
    encryptedSecret,
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
      smartContractStateEqualsOnChainState(
        decodedContract.state,
        request.onChainState,
      ) &&
      decodedContract.buyerVkey == request.SmartContractWallet!.walletVkey &&
      decodedContract.sellerVkey == request.SellerWallet.walletVkey &&
      decodedContract.buyerAddress ==
        request.SmartContractWallet!.walletAddress &&
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
  const datum = getDatumFromBlockchainIdentifier({
    buyerAddress: request.SmartContractWallet!.walletAddress,
    sellerAddress: request.SellerWallet.walletAddress,
    blockchainIdentifier: request.blockchainIdentifier,
    payByTime: decodedContract.payByTime,
    collateralReturnLovelace: decodedContract.collateralReturnLovelace,
    resultHash: decodedContract.resultHash,
    resultTime: decodedContract.resultTime,
    unlockTime: decodedContract.unlockTime,
    externalDisputeUnlockTime: decodedContract.externalDisputeUnlockTime,
    inputHash: decodedContract.inputHash,
    newCooldownTimeSeller: BigInt(0),
    newCooldownTimeBuyer: newCooldownTime(BigInt(paymentContract.cooldownTime)),
    state:
      decodedContract.resultHash == null || decodedContract.resultHash == ''
        ? SmartContractState.RefundRequested
        : SmartContractState.Disputed,
  });

  const invalidBefore =
    unixTimeToEnclosingSlot(Date.now() - 150000, SLOT_CONFIG_NETWORK[network]) -
    1;

  const initialInvalid =
    unixTimeToEnclosingSlot(Date.now() + 150000, SLOT_CONFIG_NETWORK[network]) +
    5;
  const secondaryInvalid =
    unixTimeToEnclosingSlot(
      Number(decodedContract.unlockTime) + 150000,
      SLOT_CONFIG_NETWORK[network],
    ) + 3;
  const invalidAfter = Math.min(initialInvalid, secondaryInvalid);

  const limitedFilteredUtxos = sortAndLimitUtxos(utxos);
  const collateralUtxo = limitedFilteredUtxos[0];
  if (collateralUtxo == null) {
    throw new Error('Collateral UTXO not found');
  }

  const unsignedTx =
    await generateMasumiSmartContractInteractionTransactionAutomaticFees(
      'RequestRefund',
      blockchainProvider,
      network,
      script,
      address,
      utxo,
      limitedFilteredUtxos[0],
      limitedFilteredUtxos,
      datum.value,
      invalidBefore,
      invalidAfter,
    );

  const signedTx = await wallet.signTx(unsignedTx);

  await prisma.purchaseRequest.update({
    where: { id: request.id },
    data: {
      NextAction: {
        create: {
          requestedAction: PurchasingAction.SetRefundRequestedInitiated,
        },
      },
      CurrentTransaction: {
        create: {
          txHash: null,
          status: TransactionStatus.Pending,
          BlocksWallet: {
            connect: {
              id: purchasingWallet.id,
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

  logger.debug(`Created refund request transaction:
                  Tx ID: ${txHash}
                  View (after a bit) on https://${
                    network === 'preprod' ? 'preprod.' : ''
                  }cardanoscan.io/transaction/${txHash}
                  Smart Contract Address: ${smartContractAddress}
              `);
  return true;
}

export async function requestRefundsV1() {
  let release: MutexInterface.Releaser | null;
  try {
    release = await tryAcquire(mutex).acquire();
  } catch (e) {
    logger.info('Mutex timeout when locking', { error: e });
    return;
  }

  try {
    const paymentContractsWithWalletLocked = await lockAndQueryPurchases({
      purchasingAction: PurchasingAction.SetRefundRequestedRequested,
      unlockTime: { gte: Date.now() - 1000 * 60 * 1 },
    });

    await Promise.allSettled(
      paymentContractsWithWalletLocked.map(async (paymentContract) => {
        if (paymentContract.PurchaseRequests.length == 0) return;

        const network = convertNetwork(paymentContract.network);

        logger.info(
          `Requesting ${paymentContract.PurchaseRequests.length} refunds for payment source ${paymentContract.id}`,
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
              processSinglePurchaseRequest(
                request,
                paymentContract,
                blockchainProvider,
                network,
              ),
          ),
        });

        let index = 0;
        for (const result of results) {
          const request = purchaseRequests[index];
          if (result.success == false || result.result != true) {
            const error = result.error;
            logger.error(`Error requesting refund ${request.id}`, {
              error: error,
            });
            await prisma.purchaseRequest.update({
              where: { id: request.id },
              data: {
                NextAction: {
                  create: {
                    requestedAction: PurchasingAction.WaitingForManualAction,
                    errorType: PurchaseErrorType.Unknown,
                    errorNote:
                      'Requesting refund failed: ' + errorToString(error),
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
    logger.error('Error collecting timeout refunds', { error: error });
  } finally {
    release();
  }
}
