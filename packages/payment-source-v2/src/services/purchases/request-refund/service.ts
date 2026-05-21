import { PaymentSourceType, Prisma, PurchaseErrorType, PurchasingAction } from '@/generated/prisma/client';
import { prisma } from '@masumi/payment-core/db';
import { deserializeDatum, UTxO } from '@meshsdk/core';
import type { BlockfrostProvider as MeshV2BlockfrostProvider, LanguageVersion } from '@meshsdk/core';
import type { BlockfrostProvider } from '@/services/shared';
import { logger } from '@masumi/payment-core/logger';
import { SmartContractState, smartContractStateEqualsOnChainState } from '@/utils/generator/contract-generator';
import { convertNetwork } from '@/utils/converter/network-convert';
import { DecodedV1ContractDatum, newCooldownTime } from '@/utils/converter/string-datum-convert';
import { lockAndQueryPurchases } from '@/utils/db/lock-and-query-purchases';
import { interpretBlockchainError } from '@/utils/errors/blockchain-error-interpreter';
import { advancedRetryAll, delayErrorResolver } from 'advanced-retry';
import { sortAndLimitUtxos } from '@/utils/utxo';
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
import { createDatumFromDecodedContractV2, getPaymentScriptFromPaymentSourceV2 } from '@masumi/payment-source-v2';
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
	type BatchInteractionItem,
	generateMasumiSmartContractBatchInteractionTransactionAutomaticFees,
} from '../../../builders/batch-interaction';

const REQUEST_REFUND_BATCH_SIZE = 7;

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

type ValidatedRequestRefundItem = {
	request: PurchaseRequestWithRelations;
	smartContractUtxo: UTxO;
	decodedContract: DecodedV1ContractDatum;
	newInlineDatum: ReturnType<typeof createDatumFromDecodedContractV2>['value'];
	window: TxWindowBounds;
};

const mutex = new Mutex();

function validatePurchaseRequestFields(request: PurchaseRequestWithRelations): void {
	if (request.payByTime == null) {
		throw new Error('Pay by time is null, this is deprecated');
	}
	if (request.collateralReturnLovelace == null) {
		throw new Error('Collateral return lovelace is null, this is deprecated');
	}
	if (request.CurrentTransaction?.txHash == null) {
		throw new Error('Transaction hash not found');
	}
	if (request.SmartContractWallet == null) {
		throw new Error('Purchasing wallet not found');
	}
}

async function markRequestFailed(request: PurchaseRequestWithRelations, error: unknown): Promise<void> {
	logger.error(`Error requesting V2 refund ${request.id}`, { error });
	await prisma.purchaseRequest.update({
		where: { id: request.id },
		data: {
			...connectPreviousAction(request.nextActionId),
			...createNextPurchaseAction(PurchasingAction.WaitingForManualAction, {
				errorType: PurchaseErrorType.Unknown,
				errorNote: 'Requesting refund failed: ' + interpretBlockchainError(error),
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
		logger.warn('Failed to unlock V2 request-refund hot wallet', { error, walletId });
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
			decodedContract.buyerVkey === request.SmartContractWallet!.walletVkey &&
			decodedContract.sellerVkey === request.SellerWallet.walletVkey &&
			decodedContract.buyerAddress === request.SmartContractWallet!.walletAddress &&
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

function createRequestRefundDatum(params: {
	decodedContract: DecodedV1ContractDatum;
	blockchainIdentifier: string;
	cooldownTime: bigint;
}) {
	// Aiken SetRefundRequested requires every field of the continuation datum
	// (including buyer/seller addresses AND return addresses) to equal the
	// decoded input's values. Mirror chain state to avoid DB drift failing the
	// validator. Other rewrite-able fields stay nulled via createDatumFromDecodedContractV2.
	return createDatumFromDecodedContractV2({
		decodedContract: params.decodedContract,
		buyerAddress: params.decodedContract.buyerAddress,
		buyerReturnAddress: params.decodedContract.buyerReturnAddress,
		sellerAddress: params.decodedContract.sellerAddress,
		sellerReturnAddress: params.decodedContract.sellerReturnAddress,
		blockchainIdentifier: params.blockchainIdentifier,
		resultHash: params.decodedContract.resultHash,
		newCooldownTimeSeller: BigInt(0),
		newCooldownTimeBuyer: newCooldownTime(params.cooldownTime),
		state:
			params.decodedContract.resultHash == null || params.decodedContract.resultHash === ''
				? SmartContractState.RefundRequested
				: SmartContractState.Disputed,
	});
}

async function validateAndBuildItem(
	request: PurchaseRequestWithRelations,
	paymentContract: PaymentSourceWithPurchaseRelations,
	blockchainProvider: BlockfrostProvider,
	network: 'mainnet' | 'preprod',
	smartContractAddress: string,
): Promise<ValidatedRequestRefundItem> {
	validatePurchaseRequestFields(request);
	const txHash = request.CurrentTransaction!.txHash!;
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
	const datum = createRequestRefundDatum({
		decodedContract,
		blockchainIdentifier: request.blockchainIdentifier,
		cooldownTime: BigInt(paymentContract.cooldownTime),
	});
	const { invalidBefore, invalidAfter } = createTxWindow(network, {
		constrainAfterMs: Number(decodedContract.unlockTime),
		constrainBeforeMs: Number(decodedContract.buyerCooldownTime),
	});
	return {
		request,
		smartContractUtxo: utxo,
		decodedContract,
		newInlineDatum: datum.value,
		window: { invalidBefore, invalidAfter },
	};
}

async function processSinglePurchaseRequest(
	request: PurchaseRequestWithRelations,
	paymentContract: PaymentSourceWithPurchaseRelations,
	blockchainProvider: BlockfrostProvider,
	network: 'mainnet' | 'preprod',
): Promise<boolean> {
	validatePurchaseRequestFields(request);
	const purchasingWallet = request.SmartContractWallet!;
	const walletSession = await loadHotWalletSession({
		network: paymentContract.network,
		rpcProviderApiKey: paymentContract.PaymentSourceConfig.rpcProviderApiKey,
		encryptedMnemonic: purchasingWallet.Secret.encryptedMnemonic,
		hotWalletId: purchasingWallet.id,
	});
	const { wallet, utxos, address } = walletSession;
	if (utxos.length === 0) {
		throw new Error('No UTXOs found in the wallet. Wallet is empty.');
	}
	const { script, smartContractAddress } = await getPaymentScriptFromPaymentSourceV2(paymentContract);
	const txHash = request.CurrentTransaction!.txHash!;
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
	const datum = createRequestRefundDatum({
		decodedContract,
		blockchainIdentifier: request.blockchainIdentifier,
		cooldownTime: BigInt(paymentContract.cooldownTime),
	});
	const { invalidBefore, invalidAfter } = createTxWindow(network, {
		constrainAfterMs: Number(decodedContract.unlockTime),
		constrainBeforeMs: Number(decodedContract.buyerCooldownTime),
	});

	const limitedFilteredUtxos = sortAndLimitUtxos(utxos, 8000000);
	const collateralUtxo = limitedFilteredUtxos[0];
	if (collateralUtxo == null) {
		throw new Error('Collateral UTXO not found');
	}

	const unsignedTx = await generateMasumiSmartContractInteractionTransactionAutomaticFees(
		'RequestRefund',
		blockchainProvider,
		network,
		script,
		address,
		utxo,
		collateralUtxo,
		limitedFilteredUtxos,
		datum.value,
		invalidBefore,
		invalidAfter,
		paymentContract.PaymentSourceConfig.rpcProviderApiKey,
	);

	const signedTx = await wallet.signTx(unsignedTx);

	await prisma.purchaseRequest.update({
		where: { id: request.id },
		data: {
			...connectPreviousAction(request.nextActionId),
			...createNextPurchaseAction(PurchasingAction.SetRefundRequestedInitiated),
			...createPendingTransaction(purchasingWallet.id),
			TransactionHistory: { connect: { id: request.CurrentTransaction!.id } },
		},
	});

	const newTxHash = await wallet.submitTx(signedTx);
	await walletSession.evaluateProjectedBalance(unsignedTx, limitedFilteredUtxos);
	await prisma.purchaseRequest.update({
		where: { id: request.id },
		data: updateCurrentTransactionHash(newTxHash),
	});

	logger.debug(`Created refund request transaction:
              Tx ID: ${newTxHash}
              View (after a bit) on https://${
								network === 'preprod' ? 'preprod.' : ''
							}cardanoscan.io/transaction/${newTxHash}
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
			(request) => async () => processSinglePurchaseRequest(request, paymentContract, blockchainProvider, network),
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
		logger.error('Failed to load V2 request-refund wallet session', { error, walletId: wallet.id });
		await Promise.allSettled(requests.map((request) => markRequestFailed(request, error)));
		return;
	}
	const { wallet: meshWallet, utxos, address } = walletSession;
	if (utxos.length === 0) {
		const error = new Error('No UTXOs found in the wallet. Wallet is empty.');
		await Promise.allSettled(requests.map((request) => markRequestFailed(request, error)));
		return;
	}

	const validated: ValidatedRequestRefundItem[] = [];
	for (const request of requests) {
		try {
			validated.push(
				await validateAndBuildItem(request, paymentContract, blockchainProvider, network, smartContractAddress),
			);
		} catch (error) {
			await markRequestFailed(request, error);
		}
	}
	if (validated.length === 0) {
		logger.info('No V2 request-refund items passed validation', { walletId: wallet.id });
		await unlockHotWallet(wallet.id);
		return;
	}

	const excludeRefs = validated.map((v) => v.smartContractUtxo.input);
	const collateralUtxo = pickBatchCollateral(utxos, excludeRefs);
	if (collateralUtxo == null) {
		logger.warn('V2 request-refund batch could not find collateral UTxO; falling back to single-item', {
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
		logger.warn('V2 request-refund batch could not satisfy batch invariants; falling back to single-item', {
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
			`V2 request-refund batch shrunk from ${validated.length} to ${shrinkResult.fit.length} (reason=${shrinkResult.reason})`,
		);
	}

	const fit = shrinkResult.fit;
	const droppedRequests = shrinkResult.dropped.map((v) => v.request);

	const composed = intersectTxWindows(fit.map((v) => v.window));
	if (composed == null) {
		logger.error('V2 request-refund composed window is null after shrink — falling back', { walletId: wallet.id });
		await fallbackToSingleItems(
			validated.map((v) => v.request),
			paymentContract,
			blockchainProvider,
			network,
		);
		return;
	}

	const items: BatchInteractionItem[] = fit.map((v) => ({
		type: 'RequestRefund',
		smartContractUtxo: v.smartContractUtxo,
		newInlineDatum: v.newInlineDatum,
	}));

	let unsignedTx: string;
	try {
		unsignedTx = await generateMasumiSmartContractBatchInteractionTransactionAutomaticFees(
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
		assertTxSizeWithinLimit(unsignedTx, 'v2-request-refund-batch');
	} catch (batchError) {
		logger.warn('V2 request-refund batch build failed; falling back to single-item', {
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
		logger.warn('V2 request-refund batch sign failed; falling back to single-item', {
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
			fit.map((v) =>
				prisma.purchaseRequest.update({
					where: { id: v.request.id },
					data: {
						...connectPreviousAction(v.request.nextActionId),
						...createNextPurchaseAction(PurchasingAction.SetRefundRequestedInitiated),
						...createPendingTransaction(wallet.id),
						TransactionHistory: { connect: { id: v.request.CurrentTransaction!.id } },
					},
				}),
			),
		);
	} catch (dbError) {
		logger.error('V2 request-refund batch DB pre-submit update failed', { error: dbError });
		await unlockHotWallet(wallet.id);
		return;
	}

	let newTxHash: string;
	try {
		newTxHash = await meshWallet.submitTx(signedTx);
	} catch (submitError) {
		logger.warn('V2 request-refund batch submit failed; rolling back DB and retrying as single items', {
			error: submitError,
		});
		await Promise.allSettled(
			fit.map((v) =>
				prisma.purchaseRequest.update({
					where: { id: v.request.id },
					data: {
						...connectPreviousAction(v.request.nextActionId),
						...createNextPurchaseAction(PurchasingAction.SetRefundRequestedRequested),
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
		logger.warn('V2 request-refund batch projected balance evaluation failed (non-fatal)', { error: balanceError });
	}

	try {
		await prisma.$transaction(
			fit.map((v) =>
				prisma.purchaseRequest.update({
					where: { id: v.request.id },
					data: updateCurrentTransactionHash(newTxHash),
				}),
			),
		);
	} catch (dbError) {
		logger.error('V2 request-refund batch post-submit DB update failed; tx-sync will reconcile next tick', {
			error: dbError,
			txHash: newTxHash,
		});
	}

	logger.debug(`Created V2 request-refund batch transaction:
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
						...createNextPurchaseAction(PurchasingAction.SetRefundRequestedRequested),
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

export async function requestRefundsV2() {
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
			// Aiken `must_end_before(unlock_time)` requires the tx validity upper
			// bound to be strictly less than unlock_time. The tx-window builder
			// (createTxWindow with default ~2.5min buffer + slot buffer) cannot
			// honor that constraint once unlock_time is within ~3 minutes of
			// now. Filter to leave a comfortable margin so submissions don't
			// hit the ledger boundary and fail with `OutsideValidityIntervalUTxO`.
			unlockTime: { gt: Date.now() + 1000 * 60 * 3 },
			maxBatchSize: REQUEST_REFUND_BATCH_SIZE,
			paymentSourceType: PaymentSourceType.Web3CardanoV2,
		});

		await Promise.allSettled(
			paymentContractsWithWalletLocked.map(async (paymentContract) => {
				if (paymentContract.PurchaseRequests.length == 0) return;

				const network = convertNetwork(paymentContract.network);
				logger.info(
					`Requesting ${paymentContract.PurchaseRequests.length} V2 refunds for payment source ${paymentContract.id}`,
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
		logger.error('Error collecting V2 timeout refunds', { error });
	} finally {
		release();
	}
}
