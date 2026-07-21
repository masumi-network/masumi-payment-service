import { PaymentAction, Network, Prisma } from '@/generated/prisma/client';
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
import { selectCollateralUtxo } from '@/utils/utxo';
import { retryPrismaWriteConflict } from '@/utils/db/write-conflict-retry';
import { delayErrorResolver } from 'advanced-retry';
import { advancedRetryAll } from 'advanced-retry';
import { Mutex, MutexInterface, tryAcquire } from 'async-mutex';
import { generateMasumiSmartContractInteractionTransactionAutomaticFees } from '@/utils/generator/transaction-generator';
import {
	assertEscrowUtxoUnspent,
	connectPreviousAction,
	createMeshProvider,
	createNextPaymentAction,
	createPendingTransaction,
	createTxWindow,
	loadHotWalletSession,
	runSubmitResultSubmissionLifecycle,
	writePaymentErrorTransition,
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

		// A resolved `false` means submitTx rejected and
		// processSinglePaymentRequest already restored SubmitResultRequested.
		// Only an uncaught build/lookup/database failure belongs in manual
		// recovery. Treating `false` as an unknown exception discarded the real
		// submit error and produced "Submitting result failed: Unknown error".
		if (result.success === false) {
			logger.error(`Error submitting result ${request.id}`, {
				error: interpretBlockchainError(result.error),
			});

			await prisma.$transaction((tx) =>
				writePaymentErrorTransition(tx, {
					requestId: request.id,
					nextActionId: request.nextActionId,
					errorNote: 'Submitting result failed: ' + interpretBlockchainError(result.error),
					resultHash: request.NextAction.resultHash,
				}),
			);
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

	await assertEscrowUtxoUnspent(blockchainProvider, smartContractAddress, utxo);

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

	const collateralUtxo = selectCollateralUtxo(utxos);

	const unsignedTx = await generateMasumiSmartContractInteractionTransactionAutomaticFees(
		'SubmitResult',
		blockchainProvider,
		network,
		script,
		address,
		utxo,
		collateralUtxo,
		utxos,
		datum.value,
		invalidBefore,
		invalidAfter,
	);

	const signedTx = await wallet.signTx(unsignedTx);

	// Submit before replacing CurrentTransaction. If submission is rejected,
	// the confirmed funding transaction must remain current so the next attempt
	// can locate the contract UTxO. The previous ordering installed a txHash-less
	// Pending row before submit and did not restore the confirmed transaction in
	// the catch path, making every retry start from invalid local state.
	const submissionOutcome = await runSubmitResultSubmissionLifecycle({
		submit: () => wallet.submitTx(signedTx),
		requeueRejected: async (error) => {
			logger.error('V1 submit-result transaction rejected', {
				requestId: request.id,
				error: interpretBlockchainError(error),
			});
			await retryPrismaWriteConflict(
				() =>
					prisma.paymentRequest.update({
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
					}),
				{ operationName: 'v1-submit-result-requeue-after-rejection' },
			);
		},
		evaluateProjectedBalance: () => walletSession.evaluateProjectedBalance(unsignedTx, utxos),
		recordSubmitted: async (newTxHash) => {
			await retryPrismaWriteConflict(
				() =>
					prisma.paymentRequest.update({
						where: { id: request.id },
						data: {
							...connectPreviousAction(request.nextActionId),
							...createNextPaymentAction(PaymentAction.SubmitResultInitiated, {
								resultHash: request.NextAction.resultHash,
							}),
							...createPendingTransaction(request.SmartContractWallet!.id, newTxHash),
							TransactionHistory: {
								connect: {
									id: request.CurrentTransaction!.id,
								},
							},
						},
					}),
				{ operationName: 'v1-submit-result-post-submit' },
			);
		},
		onBalanceCheckFailure: (error, newTxHash) => {
			logger.warn('V1 submit-result projected-balance check failed post-submit (non-fatal)', {
				requestId: request.id,
				txHash: newTxHash,
				error: interpretBlockchainError(error),
			});
		},
		onRecordFailure: (error, newTxHash) => {
			logger.error('V1 submit-result was accepted but its database transition could not be recorded', {
				requestId: request.id,
				txHash: newTxHash,
				error: interpretBlockchainError(error),
			});
		},
	});
	if (submissionOutcome.status === 'rejected') {
		return false;
	}
	const newTxHash = submissionOutcome.txHash;
	if (!submissionOutcome.isRecorded) {
		return true;
	}

	logger.debug(`Created submit result transaction:
                  Tx ID: ${newTxHash}
                  View (after a bit) on https://${
										network === 'preprod' ? 'preprod.' : ''
									}cardanoscan.io/transaction/${newTxHash}
                  Smart Contract Address: ${smartContractAddress}
              `);

	return true;
}

export async function submitResultV1() {
	let release: MutexInterface.Releaser | null;
	try {
		release = await tryAcquire(mutex).acquire();
	} catch {
		logger.info('submit_result_v1 is already running, skipping cycle');
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

				const blockchainProvider = await createMeshProvider(paymentContract.PaymentSourceConfig.rpcProviderApiKey);

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
