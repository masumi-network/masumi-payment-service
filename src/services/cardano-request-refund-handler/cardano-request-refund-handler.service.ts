import {
  PurchasingAction,
  TransactionStatus,
  PurchaseErrorType,
} from '@prisma/client';
import { prisma } from '@/utils/db';
import {
  BlockfrostProvider,
  deserializeDatum,
  SLOT_CONFIG_NETWORK,
  Transaction,
  unixTimeToEnclosingSlot,
} from '@meshsdk/core';
import { logger } from '@/utils/logger';
import {
  getDatum,
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
import { convertErrorString } from '@/utils/converter/error-string-convert';
import { advancedRetryAll, delayErrorResolver } from 'advanced-retry';
import { Mutex, MutexInterface, tryAcquire } from 'async-mutex';

const mutex = new Mutex();

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
          operations: purchaseRequests.map((request) => async () => {
            const purchasingWallet = request.SmartContractWallet;
            if (purchasingWallet == null)
              throw new Error('Purchasing wallet not found');
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
              const decodedContract = decodeV1ContractDatum(decodedDatum);
              if (decodedContract == null) {
                return false;
              }

              return (
                smartContractStateEqualsOnChainState(
                  decodedContract.state,
                  request.onChainState,
                ) &&
                decodedContract.buyer ==
                  request.SmartContractWallet!.walletVkey &&
                decodedContract.seller == request.SellerWallet.walletVkey &&
                decodedContract.blockchainIdentifier ==
                  request.blockchainIdentifier &&
                decodedContract.inputHash == request.inputHash &&
                BigInt(decodedContract.resultTime) ==
                  BigInt(request.submitResultTime) &&
                BigInt(decodedContract.unlockTime) ==
                  BigInt(request.unlockTime) &&
                BigInt(decodedContract.externalDisputeUnlockTime) ==
                  BigInt(request.externalDisputeUnlockTime)
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
            const decodedContract = decodeV1ContractDatum(decodedDatum);
            if (decodedContract == null) {
              throw new Error('Invalid datum');
            }
            const datum = getDatum({
              buyerVerificationKeyHash: request.SmartContractWallet!.walletVkey,
              sellerVerificationKeyHash: request.SellerWallet.walletVkey,
              blockchainIdentifier: request.blockchainIdentifier,
              resultHash: decodedContract.resultHash,
              resultTime: decodedContract.resultTime,
              unlockTime: decodedContract.unlockTime,
              externalDisputeUnlockTime:
                decodedContract.externalDisputeUnlockTime,
              inputHash: decodedContract.inputHash,
              newCooldownTimeSeller: 0,
              newCooldownTimeBuyer: newCooldownTime(
                paymentContract.cooldownTime,
              ),
              state:
                decodedContract.resultHash == ''
                  ? SmartContractState.RefundRequested
                  : SmartContractState.Disputed,
            });

            const redeemer = {
              data: {
                alternative: 1,
                fields: [],
              },
            };
            const invalidBefore =
              unixTimeToEnclosingSlot(
                Date.now() - 150000,
                SLOT_CONFIG_NETWORK[network],
              ) - 1;

            const invalidAfter =
              unixTimeToEnclosingSlot(
                Date.now() + 150000,
                SLOT_CONFIG_NETWORK[network],
              ) + 1;
            const collateralUtxo = utxos
              .sort((a, b) => {
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
                return aLovelace - bLovelace;
              })
              .find(
                (utxo) =>
                  utxo.output.amount.length == 1 &&
                  (utxo.output.amount[0].unit == 'lovelace' ||
                    utxo.output.amount[0].unit == '') &&
                  parseInt(utxo.output.amount[0].quantity) >= 3000000 &&
                  parseInt(utxo.output.amount[0].quantity) <= 20000000,
              );
            if (!collateralUtxo) {
              throw new Error('No collateral UTXO found');
            }

            const filteredUtxos = utxos
              .sort((a, b) => {
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
                //sort by biggest lovelace
                return bLovelace - aLovelace;
              })
              .filter(
                (utxo) => utxo.input.txHash != collateralUtxo.input.txHash,
              );
            const limitedFilteredUtxos = filteredUtxos.slice(
              0,
              Math.min(4, filteredUtxos.length),
            );

            const unsignedTx = new Transaction({
              initiator: wallet,
              fetcher: blockchainProvider,
            })
              .setMetadata(674, {
                msg: ['Masumi', 'SetRefundRequested'],
              })
              .setTxInputs(limitedFilteredUtxos)
              .redeemValue({
                value: utxo,
                script: script,
                redeemer: redeemer,
              })
              .setCollateral([collateralUtxo])
              .sendAssets(
                {
                  address: smartContractAddress,
                  datum: datum,
                },
                utxo.output.amount,
              )
              .setChangeAddress(address)
              .setRequiredSigners([address]);

            unsignedTx.txBuilder.invalidBefore(invalidBefore);
            unsignedTx.txBuilder.invalidHereafter(invalidAfter);
            unsignedTx.setNetwork(network);

            const buildTransaction = await unsignedTx.build();
            const estimatedFee = (await blockchainProvider.evaluateTx(
              buildTransaction,
            )) as Array<{ budget: { mem: number; steps: number } }>;
            const unsignedTxFinal = new Transaction({
              initiator: wallet,
              fetcher: blockchainProvider,
            })
              .setMetadata(674, {
                msg: ['Masumi', 'SetRefundRequested'],
              })
              .setTxInputs(limitedFilteredUtxos)
              .redeemValue({
                value: utxo,
                script: script,
                redeemer: {
                  data: redeemer.data,
                  budget: estimatedFee[0].budget,
                },
              })
              .setCollateral([collateralUtxo])
              .sendAssets(
                {
                  address: smartContractAddress,
                  datum: datum,
                },
                utxo.output.amount,
              )
              .setChangeAddress(address)
              .setRequiredSigners([address]);

            unsignedTxFinal.txBuilder.invalidBefore(invalidBefore);
            unsignedTxFinal.txBuilder.invalidHereafter(invalidAfter);
            unsignedTxFinal.setNetwork(network);

            const buildTransactionFinal = await unsignedTxFinal.build();
            const signedTx = await wallet.signTx(buildTransactionFinal);
            await prisma.purchaseRequest.update({
              where: { id: request.id },
              data: {
                NextAction: {
                  update: {
                    requestedAction:
                      PurchasingAction.SetRefundRequestedInitiated,
                  },
                },
                CurrentTransaction: {
                  create: {
                    txHash: '',
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
          }),
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
                  update: {
                    requestedAction: PurchasingAction.WaitingForManualAction,
                    errorType: PurchaseErrorType.Unknown,
                    errorNote:
                      'Requesting refund failed: ' + convertErrorString(error),
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
