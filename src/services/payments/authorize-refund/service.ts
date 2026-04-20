import { OnChainState, PaymentAction, PaymentErrorType, TransactionLayer } from '@/generated/prisma/client';
import { prisma } from '@/utils/db';
import { deserializeDatum } from '@meshsdk/core';
import { logger } from '@/utils/logger';
import {
	getDatumFromBlockchainIdentifier,
	getPaymentScriptFromPaymentSourceV1,
	SmartContractState,
	smartContractStateEqualsOnChainState,
} from '@/utils/generator/contract-generator';
import { convertNetwork } from '@/utils/converter/network-convert';
import { decodeV1ContractDatum, newCooldownTime } from '@/utils/converter/string-datum-convert';
import { lockAndQueryPayments } from '@/utils/db/lock-and-query-payments';
import { interpretBlockchainError } from '@/utils/errors/blockchain-error-interpreter';
import { advancedRetryAll, delayErrorResolver } from 'advanced-retry';
import { sortAndLimitUtxos } from '@/utils/utxo';
import { Mutex, tryAcquire, MutexInterface } from 'async-mutex';
import { generateMasumiSmartContractInteractionTransactionAutomaticFees } from '@/utils/generator/transaction-generator';
import {
	connectPreviousAction,
	createMeshProvider,
	createNextPaymentAction,
	createPendingTransaction,
	createTxWindow,
	loadHotWalletSession,
	updateCurrentTransactionHash,
} from '@/services/shared';
import { getHydraConnectionManager } from '@/services/hydra-connection-manager/hydra-connection-manager.service';
import type { HydraContext } from '@/utils/hydra/create-l2-providers';

const mutex = new Mutex();

function validatePaymentRequestFields(request: {
	payByTime: bigint | null;
	collateralReturnLovelace: bigint | null;
	CurrentTransaction: { txHash: string | null } | null;
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
			resultHash: { not: null },
			onChainState: { in: [OnChainState.Disputed] },
			maxBatchSize: 1,
		});

		await Promise.allSettled(
			paymentContractsWithWalletLocked.map(async (paymentContract) => {
				const network = convertNetwork(paymentContract.network);

				logger.info(
					`Authorizing ${paymentContract.PaymentRequests.length} refunds for payment source ${paymentContract.id}`,
				);
				const blockchainProvider = createMeshProvider(paymentContract.PaymentSourceConfig.rpcProviderApiKey);

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

						const isL2 = request.layer === 'L2';
						let hydraContext: HydraContext | undefined;

						if (isL2) {
							if (!request.CurrentTransaction?.hydraHeadId) {
								throw new Error('No hydra head id found for layer 2 payment request');
							}
							const provider = getHydraConnectionManager().getProvider(request.CurrentTransaction.hydraHeadId);
							if (!provider) {
								throw new Error(`No hydra provider found for hydra head id ${request.CurrentTransaction.hydraHeadId}`);
							}
							hydraContext = { hydraProvider: provider, hydraHeadId: request.CurrentTransaction.hydraHeadId };
						}

						const walletSession = await loadHotWalletSession({
							network: paymentContract.network,
							rpcProviderApiKey: paymentContract.PaymentSourceConfig.rpcProviderApiKey,
							encryptedMnemonic: request.SmartContractWallet!.Secret.encryptedMnemonic,
							hotWalletId: request.SmartContractWallet!.id,
							hydraContext,
						});
						const { wallet, utxos, address } = walletSession;
						if (utxos.length === 0) {
							throw new Error('No UTXOs found in the wallet. Wallet is empty.');
						}
						const { script, smartContractAddress } = await getPaymentScriptFromPaymentSourceV1(paymentContract);
						const txHash = request.CurrentTransaction?.txHash;
						if (txHash == null) {
							throw new Error('No transaction hash found');
						}
						const utxoByHash = hydraContext
							? await hydraContext.hydraProvider.fetchUTxOs(txHash)
							: await blockchainProvider.fetchUTxOs(txHash);

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
								decodedContract.buyerVkey == request.BuyerWallet!.walletVkey &&
								decodedContract.sellerVkey == request.SmartContractWallet!.walletVkey &&
								decodedContract.buyerAddress == request.BuyerWallet!.walletAddress &&
								decodedContract.sellerAddress == request.SmartContractWallet!.walletAddress &&
								decodedContract.blockchainIdentifier == request.blockchainIdentifier &&
								decodedContract.inputHash == request.inputHash &&
								BigInt(decodedContract.resultTime) == BigInt(request.submitResultTime) &&
								BigInt(decodedContract.unlockTime) == BigInt(request.unlockTime) &&
								BigInt(decodedContract.externalDisputeUnlockTime) == BigInt(request.externalDisputeUnlockTime) &&
								BigInt(decodedContract.collateralReturnLovelace) == BigInt(request.collateralReturnLovelace ?? 0) &&
								BigInt(decodedContract.payByTime) == BigInt(request.payByTime ?? 0)
							);
						});

						if (!utxo) {
							throw new Error('UTXO not found');
						}

						const buyerAddress = request.BuyerWallet!.walletAddress;
						const sellerAddress = request.SmartContractWallet!.walletAddress;

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
							buyerAddress: buyerAddress,
							sellerAddress: sellerAddress,
							blockchainIdentifier: request.blockchainIdentifier,
							inputHash: decodedContract.inputHash,
							resultHash: null,
							payByTime: decodedContract.payByTime,
							collateralReturnLovelace: decodedContract.collateralReturnLovelace,
							resultTime: decodedContract.resultTime,
							unlockTime: decodedContract.unlockTime,
							externalDisputeUnlockTime: decodedContract.externalDisputeUnlockTime,
							newCooldownTimeSeller: newCooldownTime(BigInt(paymentContract.cooldownTime)),
							newCooldownTimeBuyer: BigInt(0),
							state: SmartContractState.RefundRequested,
						});

						const { invalidBefore, invalidAfter } = createTxWindow(network);

						const limitedFilteredUtxos = sortAndLimitUtxos(utxos, 8000000);

						const unsignedTx = await generateMasumiSmartContractInteractionTransactionAutomaticFees(
							'AuthorizeRefund',
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
							hydraContext,
						);

						const signedTx = await wallet.signTx(unsignedTx);

						await prisma.paymentRequest.update({
							where: { id: request.id },
							data: {
								...connectPreviousAction(request.nextActionId),
								...createNextPaymentAction(PaymentAction.AuthorizeRefundInitiated),
								...createPendingTransaction(
									request.SmartContractWallet!.id,
									hydraContext ? { layer: TransactionLayer.L2, hydraHeadId: hydraContext.hydraHeadId } : undefined,
								),
								TransactionHistory: {
									connect: {
										id: request.CurrentTransaction!.id,
									},
								},
							},
						});
						//submit the transaction to the blockchain
						const newTxHash = await wallet.submitTx(signedTx);
						await walletSession.evaluateProjectedBalance(unsignedTx, limitedFilteredUtxos);
						await prisma.paymentRequest.update({
							where: { id: request.id },
							data: updateCurrentTransactionHash(newTxHash),
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
								...connectPreviousAction(request.nextActionId),
								...createNextPaymentAction(PaymentAction.WaitingForManualAction, {
									errorType: PaymentErrorType.Unknown,
									errorNote: 'Authorizing refund failed: ' + interpretBlockchainError(error),
								}),
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
