import {
	OnChainState,
	PaymentSourceType,
	Prisma,
	PurchaseErrorType,
	PurchasingAction,
	TransactionStatus,
} from '@/generated/prisma/client';
import { prisma } from '@masumi/payment-core/db';
import { deserializeDatum } from '@meshsdk/core';
import type { Asset, BlockfrostProvider as MeshV2BlockfrostProvider, LanguageVersion, UTxO } from '@meshsdk/core';
import type { BlockfrostProvider } from '@/services/shared';
import { logger } from '@masumi/payment-core/logger';
import { smartContractStateEqualsOnChainState } from '@/utils/generator/contract-generator';
import { convertNetwork } from '@/utils/converter/network-convert';
import { DecodedV1ContractDatum } from '@/utils/converter/string-datum-convert';
import { lockAndQueryPurchases } from '@/utils/db/lock-and-query-purchases';
import { interpretBlockchainError } from '@/utils/errors/blockchain-error-interpreter';
import { advancedRetryAll, delayErrorResolver } from 'advanced-retry';
import { sortAndLimitUtxos } from '@/utils/utxo';
import { Mutex, MutexInterface, tryAcquire } from 'async-mutex';
import { generateMasumiSmartContractWithdrawTransactionAutomaticFees } from '@/utils/generator/transaction-generator';
import {
	connectPreviousAction,
	createMeshProvider,
	createNextPurchaseAction,
	createTxWindow,
	loadHotWalletSession,
	updateCurrentTransactionHash,
} from '@/services/shared';
import { getPaymentScriptFromPaymentSourceV2 } from '@masumi/payment-source-v2';
import { decodeV2ContractDatum } from '@/utils/converter/string-datum-convert';
import {
	assertNoCollateralOverlap,
	assertTxSizeWithinLimit,
	intersectTxWindows,
	pickBatchCollateral,
	shrinkBatchToFit,
	type TxWindowBounds,
} from '../../../builders/batch-helpers';
import {
	type BatchWithdrawItem,
	generateMasumiSmartContractBatchWithdrawTransactionAutomaticFees,
} from '../../../builders/batch-interaction';

const COLLECT_REFUND_BATCH_SIZE = 7;

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

type PurchaseRequestWithRelations = PaymentSourceWithPurchaseRelations['PurchaseRequests'][number];

type ValidatedCollectRefundItem = {
	request: PurchaseRequestWithRelations;
	smartContractUtxo: UTxO;
	decodedContract: DecodedV1ContractDatum;
	collectAssets: Asset[];
	buyerRefundAddress: string;
	window: TxWindowBounds;
};

const mutex = new Mutex();

async function markRequestFailed(request: PurchaseRequestWithRelations, error: unknown): Promise<void> {
	logger.error(`Error collecting V2 refund ${request.id}`, { error });
	await prisma.purchaseRequest.update({
		where: { id: request.id },
		data: {
			...connectPreviousAction(request.nextActionId),
			...createNextPurchaseAction(PurchasingAction.WaitingForManualAction, {
				errorType: PurchaseErrorType.Unknown,
				errorNote: 'Collecting refund failed: ' + interpretBlockchainError(error),
			}),
			SmartContractWallet: { update: { lockedAt: null } },
		},
	});
}

async function unlockHotWallet(walletId: string): Promise<void> {
	try {
		await prisma.hotWallet.update({
			where: { id: walletId, deletedAt: null },
			data: { lockedAt: null },
		});
	} catch (error) {
		logger.warn('Failed to unlock V2 collect-refund hot wallet', { error, walletId });
	}
}

function findMatchingUtxo(
	utxoList: UTxO[],
	txHash: string,
	request: PurchaseRequestWithRelations,
	network: 'mainnet' | 'preprod',
	smartContractAddress: string,
): UTxO | undefined {
	return utxoList.find((utxo) => {
		if (utxo.input.txHash !== txHash) return false;
		const utxoDatum = utxo.output.plutusData;
		if (!utxoDatum) return false;
		const decodedDatum: unknown = deserializeDatum(utxoDatum);
		const decodedContract = decodeV2ContractDatum(decodedDatum, network, smartContractAddress);
		if (decodedContract == null) return false;
		return (
			smartContractStateEqualsOnChainState(decodedContract.state, request.onChainState) &&
			decodedContract.buyerVkey === request.SmartContractWallet?.walletVkey &&
			decodedContract.sellerVkey === request.SellerWallet.walletVkey &&
			decodedContract.buyerAddress === request.SmartContractWallet?.walletAddress &&
			decodedContract.sellerAddress === request.SellerWallet.walletAddress &&
			decodedContract.blockchainIdentifier === request.blockchainIdentifier &&
			decodedContract.inputHash === request.inputHash &&
			BigInt(decodedContract.resultTime) === BigInt(request.submitResultTime) &&
			BigInt(decodedContract.unlockTime) === BigInt(request.unlockTime) &&
			BigInt(decodedContract.externalDisputeUnlockTime) === BigInt(request.externalDisputeUnlockTime) &&
			BigInt(decodedContract.collateralReturnLovelace) === BigInt(request.collateralReturnLovelace ?? 0) &&
			BigInt(decodedContract.payByTime) === BigInt(request.payByTime ?? 0)
		);
	});
}

async function validateAndBuildItem(
	request: PurchaseRequestWithRelations,
	blockchainProvider: BlockfrostProvider,
	network: 'mainnet' | 'preprod',
	smartContractAddress: string,
	walletAddress: string,
): Promise<ValidatedCollectRefundItem> {
	if (request.payByTime == null) {
		throw new Error('Pay by time is null, this is deprecated');
	}
	if (request.collateralReturnLovelace == null) {
		throw new Error('Collateral return lovelace is null, this is deprecated');
	}
	if (request.SmartContractWallet == null) {
		throw new Error('Smart contract wallet not found');
	}
	const txHash = request.CurrentTransaction?.txHash;
	if (txHash == null) {
		throw new Error('Transaction hash not found');
	}
	const utxoByHash = await blockchainProvider.fetchUTxOs(txHash);
	const utxo = findMatchingUtxo(utxoByHash, txHash, request, network, smartContractAddress);
	if (!utxo) {
		throw new Error('UTXO not found');
	}
	const utxoDatum = utxo.output.plutusData;
	if (!utxoDatum) {
		throw new Error('No datum found in UTXO');
	}
	const decodedDatum: unknown = deserializeDatum(utxoDatum);
	const decodedContract = decodeV2ContractDatum(decodedDatum, network, smartContractAddress);
	if (decodedContract == null) {
		throw new Error('Invalid datum');
	}

	// Aiken contract checks the buyer refund output against the on-chain datum's
	// `buyer_return_address`. Trust the decoded datum over the DB row to stay in
	// lockstep with what the validator will accept.
	const buyerRefundAddress: string =
		decodedContract.buyerReturnAddress ??
		request.buyerReturnAddress ??
		request.SmartContractWallet.collectionAddress ??
		walletAddress;

	const { invalidBefore, invalidAfter } = createTxWindow(network);

	return {
		request,
		smartContractUtxo: utxo,
		decodedContract,
		collectAssets: utxo.output.amount,
		buyerRefundAddress,
		window: { invalidBefore, invalidAfter },
	};
}

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
	const walletSession = await loadHotWalletSession({
		network: paymentContract.network,
		rpcProviderApiKey: paymentContract.PaymentSourceConfig.rpcProviderApiKey,
		encryptedMnemonic: request.SmartContractWallet.Secret.encryptedMnemonic,
		hotWalletId: request.SmartContractWallet.id,
	});
	const { wallet, utxos, address } = walletSession;
	if (utxos.length === 0) {
		throw new Error('No UTXOs found in the wallet. Wallet is empty.');
	}

	const { script, smartContractAddress } = await getPaymentScriptFromPaymentSourceV2(paymentContract);
	const validated = await validateAndBuildItem(request, blockchainProvider, network, smartContractAddress, address);

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
		validated.smartContractUtxo,
		collateralUtxo,
		limitedFilteredUtxos,
		{
			collectAssets: validated.collectAssets,
			collectionAddress: validated.buyerRefundAddress,
		},
		null,
		null,
		validated.window.invalidBefore,
		validated.window.invalidAfter,
		// V2 contract requires the buyer's refund output to be tagged with own_ref
		// when buyer_return_address is Some. Tagging is also safe when None.
		true,
		paymentContract.PaymentSourceConfig.rpcProviderApiKey,
	);

	const signedTx = await wallet.signTx(unsignedTx);
	await prisma.purchaseRequest.update({
		where: { id: request.id },
		data: {
			...connectPreviousAction(request.nextActionId),
			...createNextPurchaseAction(PurchasingAction.WithdrawRefundInitiated, { submittedTxHash: null }),
			CurrentTransaction: {
				update: {
					txHash: null,
					status: TransactionStatus.Pending,
					BlocksWallet: { connect: { id: request.SmartContractWallet.id } },
				},
			},
			TransactionHistory: { connect: { id: request.CurrentTransaction!.id } },
		},
	});

	const newTxHash = await wallet.submitTx(signedTx);
	await walletSession.evaluateProjectedBalance(unsignedTx, limitedFilteredUtxos);
	await prisma.purchaseRequest.update({
		where: { id: request.id },
		data: updateCurrentTransactionHash(newTxHash),
	});

	logger.debug(`Created V2 refund-collection transaction:
              Tx ID: ${newTxHash}
              View on https://${network === 'preprod' ? 'preprod.' : ''}cardanoscan.io/transaction/${newTxHash}
              Smart Contract Address: ${smartContractAddress}
          `);
	return true;
}

async function fallbackToSingleItems(
	requests: PurchaseRequestWithRelations[],
	paymentContract: PaymentSourceWithPurchaseRelations,
	blockchainProvider: BlockfrostProvider,
	network: 'mainnet' | 'preprod',
): Promise<void> {
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
		operations: requests.map(
			(request) => async () => processSingleRefundCollection(request, paymentContract, blockchainProvider, network),
		),
	});

	for (let index = 0; index < results.length; index++) {
		const result = results[index];
		const request = requests[index];
		if (result.success === false || result.result !== true) {
			await markRequestFailed(request, result.error);
		}
	}
}

async function processWalletBatch(
	requests: PurchaseRequestWithRelations[],
	paymentContract: PaymentSourceWithPurchaseRelations,
	blockchainProvider: BlockfrostProvider,
	network: 'mainnet' | 'preprod',
	script: { version: LanguageVersion; code: string },
	smartContractAddress: string,
): Promise<void> {
	const firstRequest = requests[0];
	const wallet = firstRequest.SmartContractWallet!;

	let walletSession;
	try {
		walletSession = await loadHotWalletSession({
			network: paymentContract.network,
			rpcProviderApiKey: paymentContract.PaymentSourceConfig.rpcProviderApiKey,
			encryptedMnemonic: wallet.Secret.encryptedMnemonic,
			hotWalletId: wallet.id,
		});
	} catch (error) {
		logger.error('Failed to load V2 collect-refund wallet session', { error, walletId: wallet.id });
		await Promise.allSettled(requests.map((request) => markRequestFailed(request, error)));
		return;
	}
	const { wallet: meshWallet, utxos, address } = walletSession;
	if (utxos.length === 0) {
		const error = new Error('No UTXOs found in the wallet. Wallet is empty.');
		await Promise.allSettled(requests.map((request) => markRequestFailed(request, error)));
		return;
	}

	const validated: ValidatedCollectRefundItem[] = [];
	for (const request of requests) {
		try {
			validated.push(await validateAndBuildItem(request, blockchainProvider, network, smartContractAddress, address));
		} catch (error) {
			await markRequestFailed(request, error);
		}
	}
	if (validated.length === 0) {
		logger.info('No V2 collect-refund items passed validation', { walletId: wallet.id });
		await unlockHotWallet(wallet.id);
		return;
	}

	const excludeRefs = validated.map((v) => v.smartContractUtxo.input);
	const collateralUtxo = pickBatchCollateral(utxos, excludeRefs);
	if (collateralUtxo == null) {
		logger.warn('V2 collect-refund batch could not find collateral UTxO; falling back to single-item', {
			walletId: wallet.id,
		});
		await fallbackToSingleItems(
			validated.map((v) => v.request),
			paymentContract,
			blockchainProvider,
			network,
		);
		return;
	}

	const spendingUtxoKeys = new Set(
		validated.map((v) => `${v.smartContractUtxo.input.txHash}#${v.smartContractUtxo.input.outputIndex}`),
	);
	const collateralKey = `${collateralUtxo.input.txHash}#${collateralUtxo.input.outputIndex}`;
	const walletUtxos = utxos.filter((utxo) => {
		const key = `${utxo.input.txHash}#${utxo.input.outputIndex}`;
		if (key === collateralKey) return false;
		if (spendingUtxoKeys.has(key)) return false;
		return true;
	});
	const limitedFilteredUtxos = sortAndLimitUtxos(walletUtxos, 8000000);

	const shrinkResult = shrinkBatchToFit(validated, (subset) => {
		const window = intersectTxWindows(subset.map((v) => v.window));
		if (window == null) return { ok: false, reason: 'window' };
		try {
			assertNoCollateralOverlap(
				collateralUtxo,
				subset.map((v) => ({ input: v.smartContractUtxo.input })),
			);
		} catch {
			return { ok: false, reason: 'collateral' };
		}
		return { ok: true };
	});

	if (shrinkResult.fit.length === 0) {
		logger.warn('V2 collect-refund batch could not satisfy batch invariants; falling back to single-item', {
			reason: shrinkResult.reason,
			walletId: wallet.id,
		});
		await fallbackToSingleItems(
			validated.map((v) => v.request),
			paymentContract,
			blockchainProvider,
			network,
		);
		return;
	}
	if (shrinkResult.dropped.length > 0) {
		logger.warn(
			`V2 collect-refund batch shrunk from ${validated.length} to ${shrinkResult.fit.length} (reason=${shrinkResult.reason})`,
		);
	}

	const fit = shrinkResult.fit;
	const droppedRequests = shrinkResult.dropped.map((v) => v.request);

	const composed = intersectTxWindows(fit.map((v) => v.window));
	if (composed == null) {
		logger.error('V2 collect-refund composed window is null after shrink — falling back', { walletId: wallet.id });
		await fallbackToSingleItems(
			validated.map((v) => v.request),
			paymentContract,
			blockchainProvider,
			network,
		);
		return;
	}

	const items: BatchWithdrawItem[] = fit.map((v) => ({
		type: 'CollectRefund',
		smartContractUtxo: v.smartContractUtxo,
		collection: {
			collectAssets: v.collectAssets,
			collectionAddress: v.buyerRefundAddress,
		},
		fee: null,
		// CollectRefund returns ALL value (including the buyer's collateral
		// portion) via the single collection output; there is no separate
		// collateral-return output to attach here.
		collateralReturn: null,
		tagOutputsWithOwnRef: true,
	}));

	let unsignedTx: string;
	try {
		unsignedTx = await generateMasumiSmartContractBatchWithdrawTransactionAutomaticFees(
			blockchainProvider as unknown as MeshV2BlockfrostProvider,
			network,
			script,
			address,
			collateralUtxo,
			limitedFilteredUtxos,
			items,
			composed.invalidBefore,
			composed.invalidAfter,
			paymentContract.PaymentSourceConfig.rpcProviderApiKey,
		);
		assertTxSizeWithinLimit(unsignedTx, 'v2-collect-refund-batch');
	} catch (batchError) {
		logger.warn('V2 collect-refund batch build failed; falling back to single-item', {
			error: batchError,
			batchSize: fit.length,
			walletId: wallet.id,
		});
		await fallbackToSingleItems(
			validated.map((v) => v.request),
			paymentContract,
			blockchainProvider,
			network,
		);
		return;
	}

	let signedTx: string;
	try {
		signedTx = await meshWallet.signTx(unsignedTx);
	} catch (signError) {
		logger.warn('V2 collect-refund batch sign failed; falling back to single-item', {
			error: signError,
			walletId: wallet.id,
		});
		await fallbackToSingleItems(
			validated.map((v) => v.request),
			paymentContract,
			blockchainProvider,
			network,
		);
		return;
	}

	try {
		await prisma.$transaction(
			async (tx) => {
				for (const v of fit) {
					await tx.purchaseRequest.update({
						where: { id: v.request.id },
						data: {
							...connectPreviousAction(v.request.nextActionId),
							...createNextPurchaseAction(PurchasingAction.WithdrawRefundInitiated, { submittedTxHash: null }),
							CurrentTransaction: {
								update: {
									txHash: null,
									status: TransactionStatus.Pending,
									BlocksWallet: { connect: { id: wallet.id } },
								},
							},
							TransactionHistory: { connect: { id: v.request.CurrentTransaction!.id } },
						},
					});
				}
			},
			{ timeout: 30_000 },
		);
	} catch (dbError) {
		logger.error('V2 collect-refund batch DB pre-submit update failed', { error: dbError });
		await unlockHotWallet(wallet.id);
		return;
	}

	let newTxHash: string;
	try {
		newTxHash = await meshWallet.submitTx(signedTx);
	} catch (submitError) {
		logger.warn('V2 collect-refund batch submit failed; rolling back DB and retrying as single items', {
			error: submitError,
		});
		await Promise.allSettled(
			fit.map((v) =>
				prisma.purchaseRequest.update({
					where: { id: v.request.id },
					data: {
						...connectPreviousAction(v.request.nextActionId),
						...createNextPurchaseAction(PurchasingAction.WithdrawRefundRequested),
						CurrentTransaction: { disconnect: true },
					},
				}),
			),
		);
		await fallbackToSingleItems(
			validated.map((v) => v.request),
			paymentContract,
			blockchainProvider,
			network,
		);
		return;
	}

	try {
		await walletSession.evaluateProjectedBalance(unsignedTx, limitedFilteredUtxos);
	} catch (balanceError) {
		logger.warn('V2 collect-refund batch projected balance evaluation failed (non-fatal)', { error: balanceError });
	}

	try {
		await prisma.$transaction(
			async (tx) => {
				for (const v of fit) {
					await tx.purchaseRequest.update({
						where: { id: v.request.id },
						data: updateCurrentTransactionHash(newTxHash),
					});
				}
			},
			{ timeout: 30_000 },
		);
	} catch (dbError) {
		logger.error('V2 collect-refund batch post-submit DB update failed; tx-sync will reconcile next tick', {
			error: dbError,
			txHash: newTxHash,
		});
	}

	logger.debug(`Created V2 collect-refund batch transaction:
              Tx ID: ${newTxHash}
              Items: ${fit.length}
              View on https://${network === 'preprod' ? 'preprod.' : ''}cardanoscan.io/transaction/${newTxHash}
              Smart Contract Address: ${smartContractAddress}
          `);

	if (droppedRequests.length > 0) {
		await Promise.allSettled(
			droppedRequests.map((request) =>
				prisma.purchaseRequest.update({
					where: { id: request.id },
					data: {
						...connectPreviousAction(request.nextActionId),
						...createNextPurchaseAction(PurchasingAction.WithdrawRefundRequested),
						SmartContractWallet: { update: { lockedAt: null } },
					},
				}),
			),
		);
	}
}

function groupRequestsByWallet(requests: PurchaseRequestWithRelations[]): Map<string, PurchaseRequestWithRelations[]> {
	const byWallet = new Map<string, PurchaseRequestWithRelations[]>();
	for (const request of requests) {
		if (request.SmartContractWallet == null) continue;
		const list = byWallet.get(request.SmartContractWallet.id) ?? [];
		list.push(request);
		byWallet.set(request.SmartContractWallet.id, list);
	}
	return byWallet;
}

export async function collectRefundV2() {
	let release: MutexInterface.Releaser | null;
	try {
		release = await tryAcquire(mutex).acquire();
	} catch (e) {
		logger.info('Mutex timeout when locking', { error: e });
		return;
	}

	try {
		const paymentContractsWithTimedRefunds = await lockAndQueryPurchases({
			purchasingAction: PurchasingAction.WithdrawRefundRequested,
			onChainState: { in: [OnChainState.RefundRequested, OnChainState.FundsLocked] },
			resultHash: null,
			submitResultTime: { lte: Date.now() - 1000 * 60 * 10 },
			maxBatchSize: COLLECT_REFUND_BATCH_SIZE,
			paymentSourceType: PaymentSourceType.Web3CardanoV2,
		});
		const paymentContractsWithAuthorizedRefunds = await lockAndQueryPurchases({
			purchasingAction: PurchasingAction.WithdrawRefundRequested,
			onChainState: { in: [OnChainState.RefundAuthorized] },
			resultHash: null,
			paymentSourceType: PaymentSourceType.Web3CardanoV2,
			maxBatchSize: COLLECT_REFUND_BATCH_SIZE,
		});
		const paymentContractsWithWalletLocked = [
			...paymentContractsWithTimedRefunds,
			...paymentContractsWithAuthorizedRefunds,
		];

		await Promise.allSettled(
			paymentContractsWithWalletLocked.map(async (paymentContract) => {
				if (paymentContract.PurchaseRequests.length == 0) return;

				const network = convertNetwork(paymentContract.network);
				logger.info(
					`Collecting ${paymentContract.PurchaseRequests.length} V2 refunds for payment source ${paymentContract.id}`,
				);
				const blockchainProvider = await createMeshProvider(paymentContract.PaymentSourceConfig.rpcProviderApiKey);
				const { script, smartContractAddress } = await getPaymentScriptFromPaymentSourceV2(paymentContract);

				const grouped = groupRequestsByWallet(paymentContract.PurchaseRequests);
				await Promise.allSettled(
					Array.from(grouped.values()).map(async (walletRequests) => {
						if (walletRequests.length === 0) return;
						await processWalletBatch(
							walletRequests,
							paymentContract,
							blockchainProvider,
							network,
							script,
							smartContractAddress,
						);
					}),
				);
			}),
		);
	} catch (error) {
		logger.error('Error collecting V2 refunds', { error });
	} finally {
		release();
	}
}
