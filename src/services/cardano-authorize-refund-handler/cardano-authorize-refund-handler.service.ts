import {
  OnChainState,
  PaymentAction,
  PaymentErrorType,
  TransactionStatus,
} from '@prisma/client';
import { prisma } from '@/utils/db';
import {
  BlockfrostProvider,
  SLOT_CONFIG_NETWORK,
  deserializeDatum,
  unixTimeToEnclosingSlot,
  UTxO,
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
import { lockAndQueryPayments } from '@/utils/db/lock-and-query-payments';
import { convertErrorString } from '@/utils/converter/error-string-convert';
import { advancedRetryAll, delayErrorResolver } from 'advanced-retry';
import { Mutex, tryAcquire, MutexInterface } from 'async-mutex';
import { generateMasumiSmartContractInteractionTransaction } from '@/utils/generator/transaction-generator';
import { SERVICE_CONSTANTS } from '@/utils/config';

const mutex = new Mutex();

function validatePaymentRequestFields(request: {
  payByTime: bigint | null;
  collateralReturnLovelace: bigint | null;
  CurrentTransaction: { txHash: string } | null;
}): void {
  if (request.payByTime == null) {
    throw new Error('Pay by time is null, this is deprecated');
  }
  if (request.collateralReturnLovelace == null) {
    throw new Error('Collateral return lovelace is null, this is deprecated');
  }
  if (request.CurrentTransaction?.txHash == null) {
    throw new Error('No transaction hash found');
  }
}
function calculateTransactionTimeWindow(
  network: 'mainnet' | 'preprod' | 'testnet' | 'preview',
): {
  invalidBefore: number;
  invalidAfter: number;
} {
  const now = Date.now();
  const timeBuffer = SERVICE_CONSTANTS.TRANSACTION.timeBufferMs;

  const invalidBefore =
    unixTimeToEnclosingSlot(now - timeBuffer, SLOT_CONFIG_NETWORK[network]) - 1;

  const invalidAfter =
    unixTimeToEnclosingSlot(now + timeBuffer, SLOT_CONFIG_NETWORK[network]) +
    SERVICE_CONSTANTS.TRANSACTION.validitySlotBuffer;

  return { invalidBefore, invalidAfter };
}
function decodeAndValidateUtxoDatum(params: {
  utxo: UTxO;
  network: 'mainnet' | 'preprod' | 'testnet' | 'preview';
}): NonNullable<ReturnType<typeof decodeV1ContractDatum>> {
  const utxoDatum = params.utxo.output.plutusData;
  if (!utxoDatum) {
    throw new Error('No datum found in UTXO');
  }

  const decodedDatum: unknown = deserializeDatum(utxoDatum);
  const decodedContract = decodeV1ContractDatum(decodedDatum, params.network);

  if (decodedContract == null) {
    throw new Error('Invalid datum');
  }

  return decodedContract;
}

function createRefundRequestDatum(params: {
  decodedContract: NonNullable<ReturnType<typeof decodeV1ContractDatum>>;
  buyerAddress: string;
  sellerAddress: string;
  blockchainIdentifier: string;
  cooldownTime: bigint;
}): ReturnType<typeof getDatumFromBlockchainIdentifier> {
  return getDatumFromBlockchainIdentifier({
    buyerAddress: params.buyerAddress,
    sellerAddress: params.sellerAddress,
    blockchainIdentifier: params.blockchainIdentifier,
    inputHash: params.decodedContract.inputHash,
    resultHash: '',
    payByTime: params.decodedContract.payByTime,
    collateralReturnLovelace: params.decodedContract.collateralReturnLovelace,
    resultTime: params.decodedContract.resultTime,
    unlockTime: params.decodedContract.unlockTime,
    externalDisputeUnlockTime: params.decodedContract.externalDisputeUnlockTime,
    newCooldownTimeSeller: newCooldownTime(params.cooldownTime),
    newCooldownTimeBuyer: BigInt(0),
    state: SmartContractState.RefundRequested,
  });
}
export async function authorizeRefundV1() {
  let release: MutexInterface.Releaser | null;
  try {
    release = await tryAcquire(mutex).acquire();
  } catch (e) {
    logger.info('Mutex timeout when locking', { error: e });
    return;
  }

  try {
    const paymentContractsWithWalletLocked = await lockAndQueryPayments({
      paymentStatus: PaymentAction.AuthorizeRefundRequested,
      resultHash: { not: '' },
      onChainState: { in: [OnChainState.Disputed] },
    });

    await Promise.allSettled(
      paymentContractsWithWalletLocked.map(async (paymentContract) => {
        const network = convertNetwork(paymentContract.network);

        logger.info(
          `Authorizing ${paymentContract.PaymentRequests.length} refunds for payment source ${paymentContract.id}`,
        );
        const blockchainProvider = new BlockfrostProvider(
          paymentContract.PaymentSourceConfig.rpcProviderApiKey,
        );

        const paymentRequests = paymentContract.PaymentRequests;
        if (paymentRequests.length == 0) return;

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
          operations: paymentRequests.map((request) => async () => {
            validatePaymentRequestFields(request);

            const { wallet, utxos, address } = await generateWalletExtended(
              paymentContract.network,
              paymentContract.PaymentSourceConfig.rpcProviderApiKey,
              request.SmartContractWallet!.Secret.encryptedMnemonic,
            );
            if (utxos.length === 0) {
              throw new Error('No UTXOs found in the wallet. Wallet is empty.');
            }
            const { script, smartContractAddress } =
              await getPaymentScriptFromPaymentSourceV1(paymentContract);
            const txHash = request.CurrentTransaction?.txHash;
            if (txHash == null) {
              throw new Error('No transaction hash found');
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
              const decodedContract = decodeV1ContractDatum(
                decodedDatum,
                network,
              );
              if (decodedContract == null) {
                return false;
              }

              return (
                smartContractStateEqualsOnChainState(
                  decodedContract.state,
                  request.onChainState,
                ) &&
                decodedContract.buyerVkey == request.BuyerWallet!.walletVkey &&
                decodedContract.sellerVkey ==
                  request.SmartContractWallet!.walletVkey &&
                decodedContract.buyerAddress ==
                  request.BuyerWallet!.walletAddress &&
                decodedContract.sellerAddress ==
                  request.SmartContractWallet!.walletAddress &&
                decodedContract.blockchainIdentifier ==
                  request.blockchainIdentifier &&
                decodedContract.inputHash == request.inputHash &&
                BigInt(decodedContract.resultTime) ==
                  BigInt(request.submitResultTime) &&
                BigInt(decodedContract.unlockTime) ==
                  BigInt(request.unlockTime) &&
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

            const buyerAddress = request.BuyerWallet!.walletAddress;
            const sellerAddress = request.SmartContractWallet!.walletAddress;

            const decodedContract = decodeAndValidateUtxoDatum({
              utxo,
              network,
            });

            const datum = createRefundRequestDatum({
              decodedContract,
              buyerAddress,
              sellerAddress,
              blockchainIdentifier: request.blockchainIdentifier,
              cooldownTime: BigInt(paymentContract.cooldownTime),
            });

            const { invalidBefore, invalidAfter } =
              calculateTransactionTimeWindow(network);

            //sort by biggest lovelace first
            const sortedUtxosByLovelaceDesc = utxos.sort((a, b) => {
              const aLovelace = parseInt(
                a.output.amount.find(
                  (asset) => asset.unit == 'lovelace' || asset.unit == '',
                )?.quantity ?? '0',
              );
              const bLovelace = parseInt(
                b.output.amount.find(
                  (asset) => asset.unit == 'lovelace' || asset.unit == '',
                )?.quantity ?? '0',
              );
              return bLovelace - aLovelace;
            });
            const limitedUtxos = sortedUtxosByLovelaceDesc.slice(
              0,
              Math.min(4, sortedUtxosByLovelaceDesc.length),
            );

            const evaluationTx =
              await generateMasumiSmartContractInteractionTransaction(
                'AuthorizeRefund',
                blockchainProvider,
                network,
                script,
                address,
                utxo,
                sortedUtxosByLovelaceDesc[0],
                limitedUtxos,
                datum.value,
                invalidBefore,
                invalidAfter,
              );
            const estimatedFee = (await blockchainProvider.evaluateTx(
              evaluationTx,
            )) as Array<{ budget: { mem: number; steps: number } }>;
            const unsignedTx =
              await generateMasumiSmartContractInteractionTransaction(
                'AuthorizeRefund',
                blockchainProvider,
                network,
                script,
                address,
                utxo,
                sortedUtxosByLovelaceDesc[0],
                limitedUtxos,
                datum.value,
                invalidBefore,
                invalidAfter,
                estimatedFee[0].budget,
              );

            const signedTx = await wallet.signTx(unsignedTx);

            await prisma.paymentRequest.update({
              where: { id: request.id },
              data: {
                NextAction: {
                  update: {
                    requestedAction: PaymentAction.AuthorizeRefundInitiated,
                    resultHash: request.NextAction.resultHash,
                  },
                },
                CurrentTransaction: {
                  create: {
                    txHash: '',
                    status: TransactionStatus.Pending,
                    BlocksWallet: {
                      connect: {
                        id: request.SmartContractWallet!.id,
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
            await prisma.paymentRequest.update({
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
                  Tx ID: ${txHash}
                  View (after a bit) on https://${
                    network === 'preprod' ? 'preprod.' : ''
                  }cardanoscan.io/transaction/${txHash}
                  Smart Contract Address: ${smartContractAddress}
              `);
            return true;
          }),
        });
        let index = 0;
        for (const result of results) {
          const request = paymentRequests[index];
          if (result.success == false || result.result != true) {
            const error = result.error;
            logger.error(`Error authorizing refund ${request.id}`, {
              error: error,
            });
            await prisma.paymentRequest.update({
              where: { id: request.id },
              data: {
                NextAction: {
                  update: {
                    requestedAction: PaymentAction.WaitingForManualAction,
                    errorType: PaymentErrorType.Unknown,
                    errorNote:
                      'Authorizing refund failed: ' + convertErrorString(error),
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
    logger.error('Error submitting result', { error: error });
  } finally {
    release();
  }
}
