import {
  PaymentAction,
  TransactionStatus,
  PaymentErrorType,
  Network,
} from '@prisma/client';
import { prisma } from '@/utils/db';
import {
  BlockfrostProvider,
  SLOT_CONFIG_NETWORK,
  deserializeDatum,
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
import { lockAndQueryPayments } from '@/utils/db/lock-and-query-payments';
import { convertErrorString } from '@/utils/converter/error-string-convert';
import { delayErrorResolver } from 'advanced-retry';
import { advancedRetryAll } from 'advanced-retry';
import { Mutex, MutexInterface, tryAcquire } from 'async-mutex';
import { generateMasumiSmartContractInteractionTransaction } from '@/utils/generator/transaction-generator';

const mutex = new Mutex();

export async function submitResultV1() {
  let release: MutexInterface.Releaser | null;
  try {
    release = await tryAcquire(mutex).acquire();
  } catch (e) {
    logger.info('Mutex timeout when locking', { error: e });
    return;
  }

  try {
    //Submit a result for invalid tokens
    const paymentContractsWithWalletLocked = await lockAndQueryPayments({
      paymentStatus: PaymentAction.SubmitResultRequested,
      submitResultTime: {
        gte: Date.now() + 1000 * 60 * 1, //remove 1 minute for block time
      },
      requestedResultHash: { not: null },
    });

    await Promise.allSettled(
      paymentContractsWithWalletLocked.map(async (paymentContract) => {
        if (paymentContract.PaymentRequests.length == 0) return;

        logger.info(
          `Submitting ${paymentContract.PaymentRequests.length} results for payment source ${paymentContract.id}`,
        );

        const network = convertNetwork(paymentContract.network);

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
            if (request.payByTime == null) {
              throw new Error('Pay by time is null, this is deprecated');
            }
            if (request.collateralReturnLovelace == null) {
              throw new Error(
                'Collateral return lovelace is null, this is deprecated',
              );
            }
            const { wallet, utxos, address } = await generateWalletExtended(
              paymentContract.network,
              paymentContract.PaymentSourceConfig.rpcProviderApiKey,
              request.SmartContractWallet!.Secret.encryptedMnemonic,
            );

            if (utxos.length === 0) {
              //this is if the seller wallet is empty
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
                paymentContract.network == Network.Mainnet
                  ? 'mainnet'
                  : 'preprod',
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

            const utxoDatum = utxo.output.plutusData;
            if (!utxoDatum) {
              throw new Error('No datum found in UTXO');
            }

            const decodedDatum: unknown = deserializeDatum(utxoDatum);
            const decodedContract = decodeV1ContractDatum(
              decodedDatum,
              paymentContract.network == Network.Mainnet
                ? 'mainnet'
                : 'preprod',
            );
            if (decodedContract == null) {
              throw new Error('Invalid datum');
            }

            const datum = getDatumFromBlockchainIdentifier({
              buyerAddress: decodedContract.buyerAddress,
              sellerAddress: decodedContract.sellerAddress,
              blockchainIdentifier: request.blockchainIdentifier,
              payByTime: decodedContract.payByTime,
              collateralReturnLovelace:
                decodedContract.collateralReturnLovelace,
              inputHash: decodedContract.inputHash,
              resultHash: request.NextAction.resultHash ?? '',
              resultTime: decodedContract.resultTime,
              unlockTime: decodedContract.unlockTime,
              externalDisputeUnlockTime:
                decodedContract.externalDisputeUnlockTime,
              newCooldownTimeSeller: newCooldownTime(
                BigInt(paymentContract.cooldownTime),
              ),
              newCooldownTimeBuyer: BigInt(0),
              state:
                decodedContract.state == SmartContractState.Disputed ||
                decodedContract.state == SmartContractState.RefundRequested
                  ? SmartContractState.Disputed
                  : SmartContractState.ResultSubmitted,
            });

            const invalidBefore =
              unixTimeToEnclosingSlot(
                Date.now() - 150000,
                SLOT_CONFIG_NETWORK[network],
              ) - 1;

            const invalidAfter = Math.min(
              unixTimeToEnclosingSlot(
                Date.now() + 150000,
                SLOT_CONFIG_NETWORK[network],
              ) + 5,
              unixTimeToEnclosingSlot(
                Number(decodedContract.resultTime) + 150000,
                SLOT_CONFIG_NETWORK[network],
              ) + 3,
            );

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
                'SubmitResult',
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
                'SubmitResult',
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
                    requestedAction: PaymentAction.SubmitResultInitiated,
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
            try {
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

              logger.debug(`Created submit result transaction:
                  Tx ID: ${txHash}
                  View (after a bit) on https://${
                    network === 'preprod' ? 'preprod.' : ''
                  }cardanoscan.io/transaction/${txHash}
                  Smart Contract Address: ${smartContractAddress}
              `);

              return true;
            } catch (error) {
              logger.error(`Error submitting result`, { error: error });
              await prisma.paymentRequest.update({
                where: { id: request.id },
                data: {
                  NextAction: {
                    update: {
                      requestedAction: PaymentAction.SubmitResultRequested,
                      errorType: null,
                      errorNote: null,
                    },
                  },
                  SmartContractWallet: {
                    update: {
                      lockedAt: null,
                    },
                  },
                },
              });
              return false;
            }
          }),
        });
        let index = 0;
        for (const result of results) {
          const request = paymentRequests[index];
          if (result.success == false || result.result != true) {
            const error = result.error;
            logger.error(`Error submitting result ${request.id}`, {
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
                      'Submitting result failed: ' + convertErrorString(error),
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
