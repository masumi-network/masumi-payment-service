import { PurchasingAction, PurchaseErrorType, Prisma } from '@/generated/prisma/client';
import { prisma } from '@/utils/db';
import { BlockfrostProvider, deserializeDatum } from '@meshsdk/core';
import { logger } from '@/utils/logger';
import {
	getDatumFromBlockchainIdentifier,
	getPaymentScriptFromPaymentSourceV1,
	SmartContractState,
	smartContractStateEqualsOnChainState,
} from '@/utils/generator/contract-generator';
import { convertNetwork } from '@/utils/converter/network-convert';
import { decodeV1ContractDatum, newCooldownTime } from '@/utils/converter/string-datum-convert';
import { lockAndQueryPurchases } from '@/utils/db/lock-and-query-purchases';
import { interpretBlockchainError } from '@/utils/errors/blockchain-error-interpreter';
import { advancedRetryAll, delayErrorResolver } from 'advanced-retry';
import { sortAndLimitUtxos, getLovelaceFromUtxo, executeSingleUtxoSplit, MIN_LOVELACE_FOR_SPLIT } from '@/utils/utxo';
import { SERVICE_CONSTANTS } from '@/utils/config';
import { getBlockfrostInstance } from '@/utils/blockfrost';
import { Mutex, MutexInterface, tryAcquire } from 'async-mutex';
import { generateMasumiSmartContractInteractionTransactionAutomaticFees } from '@/utils/generator/transaction-generator';
import {
	connectPreviousAction,
	createMeshProvider,
	createNextPurchaseAction,
	createPendingTransaction,
	createTxWindow,
	loadHotWalletSession,
	updateCurrentTransactionHash,
} from '@/services/shared';

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

	const walletSession = await loadHotWalletSession({
		network: paymentContract.network,
		rpcProviderApiKey: paymentContract.PaymentSourceConfig.rpcProviderApiKey,
		encryptedMnemonic: encryptedSecret,
		hotWalletId: purchasingWallet.id,
	});
	const { wallet, utxos, address } = walletSession;
	if (utxos.length === 0) {
		//this is if the seller wallet is empty
		throw new Error('No UTXOs found in the wallet. Wallet is empty.');
	}

	const { script, smartContractAddress } = await getPaymentScriptFromPaymentSourceV1(paymentContract);

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
			decodedContract.buyerVkey == request.SmartContractWallet!.walletVkey &&
			decodedContract.sellerVkey == request.SellerWallet.walletVkey &&
			decodedContract.buyerAddress == request.SmartContractWallet!.walletAddress &&
			decodedContract.sellerAddress == request.SellerWallet.walletAddress &&
			decodedContract.blockchainIdentifier == request.blockchainIdentifier &&
			decodedContract.inputHash == request.inputHash &&
			BigInt(decodedContract.resultTime) == BigInt(request.submitResultTime) &&
			BigInt(decodedContract.unlockTime) == BigInt(request.unlockTime) &&
			BigInt(decodedContract.externalDisputeUnlockTime) == BigInt(request.externalDisputeUnlockTime) &&
			BigInt(decodedContract.collateralReturnLovelace) == BigInt(request.collateralReturnLovelace!) &&
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

	const { invalidBefore, invalidAfter } = createTxWindow(network, {
		constrainAfterMs: Number(decodedContract.unlockTime),
	});

	// Collateral requires a single UTXO with ≥5 ADA per the Cardano protocol.
	const collateralMinLovelace = parseInt(SERVICE_CONSTANTS.SMART_CONTRACT.collateralAmount, 10);
	let currentUtxos = utxos;
	let splitAttempts = 0;
	const maxSplitAttempts = 3;
	while (true) {
		let limitedFilteredUtxos;
		try {
			limitedFilteredUtxos = sortAndLimitUtxos(
				currentUtxos,
				8_000_000,
				collateralMinLovelace,
				2, // collateral and inputs must be disjoint
			);
		} catch (utxoErr) {
			logger.error('RequestRefund sortAndLimitUtxos failed', {
				requestId: request.id,
				utxoCount: currentUtxos.length,
				error: errorToString(utxoErr),
			});
			throw utxoErr;
		}
		if (limitedFilteredUtxos.length >= 2) {
			break;
		}
		if (splitAttempts >= maxSplitAttempts) {
			throw new Error(
				`RequestRefund requires at least 2 UTxOs (one for collateral ≥${collateralMinLovelace / 1_000_000} ADA, one for inputs). ` +
					`Gave up after ${maxSplitAttempts} split attempt(s). Please add more funds.`,
			);
		}
		const singleUtxo = currentUtxos.find((u) => getLovelaceFromUtxo(u) >= MIN_LOVELACE_FOR_SPLIT);
		const singleUtxoLovelace = singleUtxo != null ? getLovelaceFromUtxo(singleUtxo) : 0;
		if (singleUtxo != null && singleUtxoLovelace >= MIN_LOVELACE_FOR_SPLIT) {
			splitAttempts++;
			logger.info('RequestRefund: splitting single UTXO for collateral/input disjointness', {
				requestId: request.id,
				lovelace: singleUtxoLovelace,
				attempt: splitAttempts,
			});
			const blockfrost = getBlockfrostInstance(
				paymentContract.network,
				paymentContract.PaymentSourceConfig.rpcProviderApiKey,
			);
			await executeSingleUtxoSplit({
				wallet,
				blockchainProvider,
				address,
				network,
				singleUtxo,
				blockfrost,
				// Split out a collateral-grade output (5 ADA); change covers inputs.
				splitOutputLovelace: collateralMinLovelace,
			});
			const refreshed = await generateWalletExtended(
				paymentContract.network,
				paymentContract.PaymentSourceConfig.rpcProviderApiKey,
				encryptedSecret,
			);
			currentUtxos = refreshed.utxos;
			continue;
		}
		throw new Error(
			`RequestRefund requires at least 2 UTxOs (one for collateral ≥${collateralMinLovelace / 1_000_000} ADA, one for inputs). ` +
				'No single UTXO is large enough to split. Please add more funds.',
		);
	}

	const limitedFilteredUtxos = sortAndLimitUtxos(currentUtxos, 8_000_000, collateralMinLovelace, 2);
	const collateralUtxo = limitedFilteredUtxos[0];
	const inputUtxos = limitedFilteredUtxos.slice(1);
	if (collateralUtxo == null || inputUtxos.length === 0) {
		throw new Error('Collateral or input UTXOs not found (expected at least 2 UTxOs)');
	}

	const unsignedTx = await generateMasumiSmartContractInteractionTransactionAutomaticFees(
		'RequestRefund',
		blockchainProvider,
		network,
		script,
		address,
		utxo,
		collateralUtxo,
		inputUtxos,
		datum.value,
		invalidBefore,
		invalidAfter,
	);

	const signedTx = await wallet.signTx(unsignedTx);

	await prisma.purchaseRequest.update({
		where: { id: request.id },
		data: {
			...connectPreviousAction(request.nextActionId),
			...createNextPurchaseAction(PurchasingAction.SetRefundRequestedInitiated),
			...createPendingTransaction(purchasingWallet.id),
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
	await prisma.purchaseRequest.update({
		where: { id: request.id },
		data: updateCurrentTransactionHash(newTxHash),
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
			maxBatchSize: 1,
		});

		await Promise.allSettled(
			paymentContractsWithWalletLocked.map(async (paymentContract) => {
				if (paymentContract.PurchaseRequests.length == 0) return;

				const network = convertNetwork(paymentContract.network);

				logger.info(
					`Requesting ${paymentContract.PurchaseRequests.length} refunds for payment source ${paymentContract.id}`,
				);
				const blockchainProvider = createMeshProvider(paymentContract.PaymentSourceConfig.rpcProviderApiKey);

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
							processSinglePurchaseRequest(request, paymentContract, blockchainProvider, network),
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
								...connectPreviousAction(request.nextActionId),
								...createNextPurchaseAction(PurchasingAction.WaitingForManualAction, {
									errorType: PurchaseErrorType.Unknown,
									errorNote: 'Requesting refund failed: ' + interpretBlockchainError(error),
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
		logger.error('Error collecting timeout refunds', { error: error });
	} finally {
		release();
	}
}
