import { PaymentAction, PaymentErrorType, Network, Prisma } from '@/generated/prisma/client';
import { prisma } from '@/utils/db';
import { BlockfrostProvider, deserializeDatum, UTxO } from '@meshsdk/core';
import { logger } from '@/utils/logger';
import {
	getDatumFromBlockchainIdentifier,
	getPaymentScriptFromPaymentSourceV1,
	SmartContractState,
	smartContractStateEqualsOnChainState,
} from '@/utils/generator/contract-generator';
import { convertNetwork } from '@/utils/converter/network-convert';
import { decodeV1ContractDatum, DecodedV1ContractDatum, newCooldownTime } from '@/utils/converter/string-datum-convert';
import { lockAndQueryPayments } from '@/utils/db/lock-and-query-payments';
import { interpretBlockchainError } from '@/utils/errors/blockchain-error-interpreter';
import { sortAndLimitUtxos } from '@/utils/utxo';
import { delayErrorResolver } from 'advanced-retry';
import { advancedRetryAll } from 'advanced-retry';
import { Mutex, MutexInterface, tryAcquire } from 'async-mutex';
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

type PaymentSourceWithRelations = Prisma.PaymentSourceGetPayload<{
	include: {
		PaymentRequests: {
			include: {
				NextAction: true;
				CurrentTransaction: true;
				RequestedFunds: true;
				BuyerWallet: true;
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

type PaymentRequestWithRelations = PaymentSourceWithRelations['PaymentRequests'][number];

type MatchingUtxoResult = {
	utxo: UTxO;
	decodedContract: DecodedV1ContractDatum;
};

const mutex = new Mutex();

/**
 * Determines the new contract state based on current state
 */
function determineNewContractState(currentState: SmartContractState): SmartContractState {
	if (currentState === SmartContractState.Disputed || currentState === SmartContractState.RefundRequested) {
		return SmartContractState.Disputed;
	}
	return SmartContractState.ResultSubmitted;
}

/**
 * Handles the results of payment request processing
 */
async function handlePaymentRequestResults(
	results: Array<{ success: boolean; result?: boolean; error?: unknown }>,
	paymentRequests: PaymentRequestWithRelations[],
): Promise<void> {
	for (let index = 0; index < results.length; index++) {
		const result = results[index];
		const request = paymentRequests[index];

		if (result.success === false || result.result !== true) {
			logger.error(`Error submitting result ${request.id}`, {
				error: result.error,
			});

			await prisma.paymentRequest.update({
				where: { id: request.id },
				data: {
					...connectPreviousAction(request.nextActionId),
					...createNextPaymentAction(PaymentAction.WaitingForManualAction, {
						errorType: PaymentErrorType.Unknown,
						errorNote: 'Submitting result failed: ' + interpretBlockchainError(result.error),
					}),
					SmartContractWallet: {
						update: {
							lockedAt: null,
						},
					},
				},
			});
		}
	}
}

async function findMatchingUtxoAndDecodeContract(
	utxoList: UTxO[],
	txHash: string,
	request: PaymentRequestWithRelations,
	network: Network,
): Promise<MatchingUtxoResult | undefined> {
	for (const utxo of utxoList) {
		if (utxo.input.txHash !== txHash) {
			continue;
		}

		const utxoDatum = utxo.output.plutusData;
		if (!utxoDatum) {
			continue;
		}

		const decodedDatum: unknown = deserializeDatum(utxoDatum);
		const decodedContract = decodeV1ContractDatum(decodedDatum, network === Network.Mainnet ? 'mainnet' : 'preprod');
		if (decodedContract === null) {
			continue;
		}

		if (!smartContractStateEqualsOnChainState(decodedContract.state, request.onChainState)) {
			continue;
		}
		if (decodedContract.buyerVkey !== request.BuyerWallet!.walletVkey) {
			continue;
		}
		if (decodedContract.sellerVkey !== request.SmartContractWallet!.walletVkey) {
			continue;
		}
		if (decodedContract.buyerAddress !== request.BuyerWallet!.walletAddress) {
			continue;
		}
		if (decodedContract.sellerAddress !== request.SmartContractWallet!.walletAddress) {
			continue;
		}
		if (decodedContract.blockchainIdentifier !== request.blockchainIdentifier) {
			continue;
		}
		if (decodedContract.inputHash !== request.inputHash) {
			continue;
		}
		if (BigInt(decodedContract.resultTime) !== BigInt(request.submitResultTime)) {
			continue;
		}
		if (BigInt(decodedContract.unlockTime) !== BigInt(request.unlockTime)) {
			continue;
		}
		if (BigInt(decodedContract.externalDisputeUnlockTime) !== BigInt(request.externalDisputeUnlockTime)) {
			continue;
		}
		if (BigInt(decodedContract.collateralReturnLovelace) !== BigInt(request.collateralReturnLovelace!)) {
			continue;
		}
		if (BigInt(decodedContract.payByTime) !== BigInt(request.payByTime!)) {
			continue;
		}

		return { utxo, decodedContract };
	}

	return undefined;
}

async function processSinglePaymentRequest(
	request: PaymentRequestWithRelations,
	paymentContract: PaymentSourceWithRelations,
	blockchainProvider: BlockfrostProvider,
	network: 'mainnet' | 'preprod',
): Promise<boolean> {
	if (request.payByTime == null) {
		throw new Error('Pay by time is null, this is deprecated');
	}
	if (request.collateralReturnLovelace == null) {
		throw new Error('Collateral return lovelace is null, this is deprecated');
	}
	const walletSession = await loadHotWalletSession({
		network: paymentContract.network,
		rpcProviderApiKey: paymentContract.PaymentSourceConfig.rpcProviderApiKey,
		encryptedMnemonic: request.SmartContractWallet!.Secret.encryptedMnemonic,
		hotWalletId: request.SmartContractWallet!.id,
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
	const utxoByHash = await blockchainProvider.fetchUTxOs(txHash);

	const matchResult = await findMatchingUtxoAndDecodeContract(utxoByHash, txHash, request, paymentContract.network);

	if (!matchResult) {
		throw new Error('UTXO not found');
	}

	const { utxo, decodedContract } = matchResult;

	const datum = getDatumFromBlockchainIdentifier({
		buyerAddress: decodedContract.buyerAddress,
		sellerAddress: decodedContract.sellerAddress,
		blockchainIdentifier: request.blockchainIdentifier,
		payByTime: decodedContract.payByTime,
		collateralReturnLovelace: decodedContract.collateralReturnLovelace,
		inputHash: decodedContract.inputHash,
		resultHash: request.NextAction.resultHash,
		resultTime: decodedContract.resultTime,
		unlockTime: decodedContract.unlockTime,
		externalDisputeUnlockTime: decodedContract.externalDisputeUnlockTime,
		newCooldownTimeSeller: newCooldownTime(BigInt(paymentContract.cooldownTime)),
		newCooldownTimeBuyer: BigInt(0),
		state: determineNewContractState(decodedContract.state),
	});

	const { invalidBefore, invalidAfter } = createTxWindow(network, {
		constrainAfterMs: Number(decodedContract.resultTime),
	});

	const limitedUtxos = sortAndLimitUtxos(utxos, 8000000);

	const unsignedTx = await generateMasumiSmartContractInteractionTransactionAutomaticFees(
		'SubmitResult',
		blockchainProvider,
		network,
		script,
		address,
		utxo,
		limitedUtxos[0],
		limitedUtxos,
		datum.value,
		invalidBefore,
		invalidAfter,
	);

	const signedTx = await wallet.signTx(unsignedTx);

	await prisma.paymentRequest.update({
		where: { id: request.id },
		data: {
			...connectPreviousAction(request.nextActionId),
			...createNextPaymentAction(PaymentAction.SubmitResultInitiated),
			...createPendingTransaction(request.SmartContractWallet!.id),
			TransactionHistory: {
				connect: {
					id: request.CurrentTransaction!.id,
				},
			},
		},
	});
	try {
		const newTxHash = await wallet.submitTx(signedTx);
		await walletSession.evaluateProjectedBalance(unsignedTx, limitedUtxos);
		await prisma.paymentRequest.update({
			where: { id: request.id },
			data: updateCurrentTransactionHash(newTxHash),
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
				...connectPreviousAction(request.nextActionId),
				...createNextPaymentAction(PaymentAction.SubmitResultRequested, {
					errorType: null,
					errorNote: null,
					resultHash: request.NextAction.resultHash,
				}),
				SmartContractWallet: {
					update: {
						lockedAt: null,
					},
				},
			},
		});
		return false;
	}
}

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
				gte: Date.now() + 1000 * 60 * 1,
			},
			requestedResultHash: { not: null },
			maxBatchSize: 1,
		});

		await Promise.allSettled(
			paymentContractsWithWalletLocked.map(async (paymentContract) => {
				if (paymentContract.PaymentRequests.length == 0) return;

				logger.info(
					`Submitting ${paymentContract.PaymentRequests.length} results for payment source ${paymentContract.id}`,
				);

				const network = convertNetwork(paymentContract.network);

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
					operations: paymentRequests.map(
						(request) => async () => processSinglePaymentRequest(request, paymentContract, blockchainProvider, network),
					),
				});
				await handlePaymentRequestResults(results, paymentRequests);
			}),
		);
	} catch (error) {
		logger.error('Error submitting result', { error: error });
	} finally {
		release();
	}
}
