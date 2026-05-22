import {
	OnChainState,
	PaymentAction,
	PaymentErrorType,
	PaymentSourceType,
	TransactionStatus,
	Prisma,
} from '@/generated/prisma/client';
import { prisma } from '@masumi/payment-core/db';
import { Asset, deserializeDatum } from '@meshsdk/core';
import type { BlockfrostProvider as MeshV2BlockfrostProvider, LanguageVersion, UTxO } from '@meshsdk/core';
import type { BlockfrostProvider } from '@/services/shared';
import { logger } from '@masumi/payment-core/logger';
import { smartContractStateEqualsOnChainState } from '@/utils/generator/contract-generator';
import { convertNetwork } from '@/utils/converter/network-convert';
import { DecodedV1ContractDatum } from '@/utils/converter/string-datum-convert';
import { lockAndQueryPayments } from '@/utils/db/lock-and-query-payments';
import { retryOnSerializationConflict } from '@/utils/db/retry';
import { interpretBlockchainError } from '@/utils/errors/blockchain-error-interpreter';
import { advancedRetry, delayErrorResolver } from 'advanced-retry';
import { sortAndLimitUtxos } from '@/utils/utxo';
import { Mutex, MutexInterface, tryAcquire } from 'async-mutex';
import { generateMasumiSmartContractWithdrawTransactionAutomaticFees } from '@/utils/generator/transaction-generator';
import {
	connectExistingTransaction,
	connectPreviousAction,
	createMeshProvider,
	createNextPaymentAction,
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

// V2 collection sizing. Withdraw legs each produce one Spend redeemer + one
// collection output + an optional collateral-return output, all tagged with
// own_ref. Per-input cost is comparable to interactions; 6 keeps total
// ex-units within the protocol limit with headroom.
const COLLECTION_BATCH_SIZE = 7;

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

type ValidatedCollectionItem = {
	request: PaymentRequestWithRelations;
	smartContractUtxo: UTxO;
	decodedContract: DecodedV1ContractDatum;
	collectAssets: Asset[];
	collectionAddress: string;
	collateralReturn: { lovelace: bigint; address: string };
	window: TxWindowBounds;
};

// Sentinel prefix used in thrown error messages from validateAndBuildItem
// to signal that the failure is a CHAIN-LOOKUP miss, not a DB-shape error.
// The catch site in processWalletBatch recognises this prefix and SKIPS
// the item — leaves it in its `*Requested` state for the next scheduler
// tick — instead of calling markRequestFailed.
//
// Chain-state authority belongs to the tx-sync service: it watches contract
// events and rewrites DB state when chain state changes. Marking a request
// as `WaitingForManualAction` from within an action service races tx-sync
// (the UTxO might have been spent by an external observer, or blockfrost
// might just be lagged), and once a request is parked in
// `WaitingForManualAction` the scheduler will never re-pick it up. Defer
// the call and let tx-sync drive any terminal transition.
const LOOKUP_DEFERRED_PREFIX = 'V2_BATCH_LOOKUP_DEFERRED:';

function isLookupDeferred(error: unknown): boolean {
	return error instanceof Error && error.message.startsWith(LOOKUP_DEFERRED_PREFIX);
}

/**
 * Wrap `fetchUTxOs(txHash)` with progressive retries when the first call
 * returns an empty list. The most common cause is blockfrost not having
 * indexed a freshly-landed tx yet (5-30s+ lag after block confirmation on
 * preprod). The 3-step backoff (5s, 10s, 20s) covers the long tail of slow
 * indexing without burning the whole scheduler tick on a single item; if
 * STILL empty after the final attempt, we throw the transient sentinel so
 * the caller defers to the next tick instead of marking the request as
 * failed.
 */
async function fetchUTxOsWithDeferOnEmpty(blockchainProvider: BlockfrostProvider, txHash: string): Promise<UTxO[]> {
	const backoffMs = [5_000, 10_000, 20_000];
	const first = await blockchainProvider.fetchUTxOs(txHash);
	if (first.length > 0) return first;
	for (const wait of backoffMs) {
		await new Promise((resolve) => setTimeout(resolve, wait));
		const next = await blockchainProvider.fetchUTxOs(txHash);
		if (next.length > 0) return next;
	}
	const totalSeconds = backoffMs.reduce((sum, ms) => sum + ms, 0) / 1000;
	throw new Error(
		`${LOOKUP_DEFERRED_PREFIX} fetchUTxOs(${txHash}) returned empty after ${backoffMs.length + 1} attempts (${totalSeconds}s total wait) — chain state not visible to blockfrost yet, deferring to tx-sync / next tick`,
	);
}

const mutex = new Mutex();

async function markRequestFailed(request: PaymentRequestWithRelations, error: unknown): Promise<void> {
	logger.error(`Error collecting V2 payments ${request.id}`, { error });
	await prisma.paymentRequest.update({
		where: { id: request.id },
		data: {
			...connectPreviousAction(request.nextActionId),
			...createNextPaymentAction(PaymentAction.WaitingForManualAction, {
				errorType: PaymentErrorType.Unknown,
				errorNote: 'Collecting payments failed: ' + interpretBlockchainError(error),
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
		logger.warn('Failed to unlock V2 collection hot wallet', { error, walletId });
	}
}

function findMatchingUtxo(
	utxoList: UTxO[],
	txHash: string,
	request: PaymentRequestWithRelations,
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
			decodedContract.buyerAddress === request.BuyerWallet!.walletAddress &&
			decodedContract.sellerAddress === request.SmartContractWallet!.walletAddress &&
			decodedContract.buyerVkey === request.BuyerWallet!.walletVkey &&
			decodedContract.sellerVkey === request.SmartContractWallet!.walletVkey &&
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
	request: PaymentRequestWithRelations,
	blockchainProvider: BlockfrostProvider,
	network: 'mainnet' | 'preprod',
	smartContractAddress: string,
): Promise<ValidatedCollectionItem> {
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
	const utxoByHash = await fetchUTxOsWithDeferOnEmpty(blockchainProvider, txHash);
	const utxo = findMatchingUtxo(utxoByHash, txHash, request, network, smartContractAddress);
	if (!utxo) {
		throw new Error(`${LOOKUP_DEFERRED_PREFIX} UTXO not found`);
	}
	const utxoDatum = utxo.output.plutusData;
	if (!utxoDatum) {
		throw new Error(`${LOOKUP_DEFERRED_PREFIX} No datum found in UTXO`);
	}
	const decodedDatum: unknown = deserializeDatum(utxoDatum);
	const decodedContract = decodeV2ContractDatum(decodedDatum, network, smartContractAddress);
	if (decodedContract == null) {
		throw new Error(`${LOOKUP_DEFERRED_PREFIX} Invalid datum`);
	}

	if (BigInt(decodedContract.collateralReturnLovelace) !== request.collateralReturnLovelace) {
		logger.error(
			'Collateral return lovelace does not match collateral return lovelace in db. This likely is a spoofing attempt.',
			{
				purchaseRequestId: request.id,
				collateralReturnLovelace: decodedContract.collateralReturnLovelace,
			},
		);
		throw new Error(
			'Collateral return lovelace does not match collateral return lovelace in db. This likely is a spoofing attempt.',
		);
	}

	const buyerAddress = request.BuyerWallet?.walletAddress;
	if (buyerAddress == null) {
		throw new Error('Buyer wallet not found');
	}
	if (buyerAddress !== decodedContract.buyerAddress) {
		throw new Error('Buyer wallet does not match buyer in contract');
	}

	// V2 has zero protocol fees: every input asset moves to the collection address as-is.
	const remainingAssets: { [key: string]: Asset } = {};
	for (const assetValue of utxo.output.amount) {
		remainingAssets[assetValue.unit] = {
			unit: assetValue.unit,
			quantity: assetValue.quantity,
		};
	}

	// Aiken contract validates the seller payout output against the on-chain
	// datum's `seller_return_address`. Trust the decoded datum first so we stay
	// in lockstep with what the validator will accept.
	let collectionAddress: string | null =
		decodedContract.sellerReturnAddress ?? request.sellerReturnAddress ?? request.SmartContractWallet.collectionAddress;
	if (collectionAddress == null || collectionAddress === '') {
		collectionAddress = request.SmartContractWallet.walletAddress;
	}

	const { invalidBefore, invalidAfter } = createTxWindow(network, {
		constrainBeforeMs: Number(decodedContract.sellerCooldownTime),
	});

	return {
		request,
		smartContractUtxo: utxo,
		decodedContract,
		collectAssets: Object.values(remainingAssets),
		collectionAddress,
		collateralReturn: {
			lovelace: request.collateralReturnLovelace,
			// Aiken `Withdraw` checks the collateral return output via
			// `outputs_with_reference_tag(..., buyer, buyer_return_address)`.
			// When buyer_return_address is Some the validator demands the
			// collateral land at that address, NOT at the buyer's vkey address.
			address: decodedContract.buyerReturnAddress ?? buyerAddress,
		},
		window: { invalidBefore, invalidAfter },
	};
}

async function processSinglePaymentCollection(
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
	const validated = await validateAndBuildItem(request, blockchainProvider, network, smartContractAddress);

	const limitedFilteredUtxos = sortAndLimitUtxos(utxos, 8000000);
	const collateralUtxo = limitedFilteredUtxos[0];
	if (collateralUtxo == null) {
		throw new Error('Collateral UTXO not found');
	}

	const unsignedTx = await generateMasumiSmartContractWithdrawTransactionAutomaticFees(
		'CollectCompleted',
		blockchainProvider,
		network,
		script,
		address,
		validated.smartContractUtxo,
		collateralUtxo,
		limitedFilteredUtxos,
		{
			collectAssets: validated.collectAssets,
			collectionAddress: validated.collectionAddress,
		},
		null,
		{
			lovelace: validated.collateralReturn.lovelace,
			address: validated.collateralReturn.address,
			txHash: validated.smartContractUtxo.input.txHash,
			outputIndex: validated.smartContractUtxo.input.outputIndex,
		},
		validated.window.invalidBefore,
		validated.window.invalidAfter,
		// V2 contract requires the seller's main output to be tagged with own_ref
		// when seller_return_address is Some. Tagging is also safe when None.
		true,
		paymentContract.PaymentSourceConfig.rpcProviderApiKey,
	);

	const signedTx = await wallet.signTx(unsignedTx);
	await prisma.paymentRequest.update({
		where: { id: request.id },
		data: {
			...connectPreviousAction(request.nextActionId),
			...createNextPaymentAction(PaymentAction.WithdrawInitiated),
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
	await prisma.paymentRequest.update({
		where: { id: request.id },
		data: updateCurrentTransactionHash(newTxHash),
	});

	logger.debug(`Created V2 withdrawal transaction:
        Tx ID: ${newTxHash}
        View on https://${network === 'preprod' ? 'preprod.' : ''}cardanoscan.io/transaction/${newTxHash}
        Smart Contract Address: ${smartContractAddress}
    `);
	return true;
}

async function fallbackToSingleItems(
	requests: PaymentRequestWithRelations[],
	paymentContract: PaymentSourceWithRelations,
	blockchainProvider: BlockfrostProvider,
	network: 'mainnet' | 'preprod',
): Promise<void> {
	// Process AT MOST ONE item, not all N. Submitting the first item
	// creates a PendingTransaction that locks the hot wallet, so any
	// subsequent item in this tick would just race the wallet lock and
	// fail. The remaining items stay in their queued state — next
	// scheduler tick (after tx-sync clears the lock) re-picks them up
	// and batches them again. The fallback exists purely so a single
	// bad item (invalid datum, expired window, etc.) does not block the
	// rest forever; it is NOT a parallel retry path. In the happy path
	// the batch builder above handles everything in one tx and this
	// function never runs.
	if (requests.length === 0) return;
	const request = requests[0];
	try {
		await advancedRetry({
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
			operation: async () => {
				const ok = await processSinglePaymentCollection(request, paymentContract, blockchainProvider, network);
				if (!ok) throw new Error('processSingle returned false');
				return ok;
			},
		});
	} catch (error) {
		if (isLookupDeferred(error)) {
			// Same defer-to-tx-sync semantics as the batch validation pass:
			// chain lookup miss is NOT a per-item failure; leave the request
			// queued and let tx-sync drive any terminal transition.
			logger.info(
				`Deferring V2 single-item fallback (chain lookup not ready); request ${request.id} stays queued for tx-sync to reconcile`,
				{ error: error instanceof Error ? error.message : error },
			);
		} else {
			await markRequestFailed(request, error);
		}
	}
	// requests[1..] are intentionally left untouched — they remain in
	// their `*Requested` state and the next tick (after the wallet
	// unlocks) will batch them again. Do NOT call markRequestFailed on
	// them here: a batch build failure caused by a transient issue
	// (network blip, blockfrost lag, cost-model sync race) is not a
	// per-item failure and the items deserve another chance.
}

async function processWalletBatch(
	requests: PaymentRequestWithRelations[],
	paymentContract: PaymentSourceWithRelations,
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
		logger.warn(
			'V2 collection batch could not load wallet session; leaving items in pool for next tick [batch-fallback]',
			{
				error: error instanceof Error ? { message: error.message, stack: error.stack, name: error.name } : error,
				walletId: wallet.id,
				batchSize: requests.length,
			},
		);
		// Wallet-load failure is NOT a per-item failure: every request
		// in this batch was waiting on the same wallet. Marking them all
		// as `WaitingForManualAction` would terminate good requests for
		// a transient infra issue. Unlock the hot wallet and leave the
		// requests in their queued state — next tick (after the wallet
		// session loads cleanly) re-batches them.
		await unlockHotWallet(wallet.id);
		return;
	}
	const { wallet: meshWallet, utxos, address } = walletSession;
	if (utxos.length === 0) {
		logger.warn('V2 batch hot wallet returned no UTxOs; leaving items in pool for next tick [batch-fallback]', {
			walletId: wallet.id,
			batchSize: requests.length,
		});
		// Empty wallet is a transient operational issue (faucet ran out,
		// pending state still settling). NOT a per-item failure — leave
		// items queued for the next tick after the wallet has UTxOs.
		await unlockHotWallet(wallet.id);
		return;
	}

	const validated: ValidatedCollectionItem[] = [];
	for (const request of requests) {
		try {
			validated.push(await validateAndBuildItem(request, blockchainProvider, network, smartContractAddress));
		} catch (error) {
			if (isLookupDeferred(error)) {
				// Chain-lookup miss (blockfrost not caught up, or the UTxO
				// has already been consumed by something tx-sync has not
				// observed yet). Leave the request queued — tx-sync owns
				// the chain-state truth and will drive any terminal
				// transition. Logged at info because it is expected during
				// indexer lag.
				logger.info(
					`Deferring V2 batch item this tick (chain lookup not ready); request ${request.id} stays queued for tx-sync to reconcile`,
					{ error: error instanceof Error ? error.message : error },
				);
			} else {
				await markRequestFailed(request, error);
			}
		}
	}
	if (validated.length === 0) {
		logger.info(
			'No V2 collection items in this tick reached the batch builder (every item was either deferred for tx-sync to reconcile or marked failed); leaving wallet unlocked',
			{ walletId: wallet.id },
		);
		await unlockHotWallet(wallet.id);
		return;
	}

	const excludeRefs = validated.map((v) => v.smartContractUtxo.input);
	const collateralUtxo = pickBatchCollateral(utxos, excludeRefs);
	if (collateralUtxo == null) {
		logger.warn('V2 collection batch could not find collateral UTxO; falling back to single-item [batch-fallback]', {
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
		logger.warn(
			'V2 collection batch could not satisfy batch invariants; falling back to single-item [batch-fallback]',
			{
				reason: shrinkResult.reason,
				walletId: wallet.id,
			},
		);
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
			`V2 collection batch shrunk from ${validated.length} to ${shrinkResult.fit.length} (reason=${shrinkResult.reason})`,
		);
	}

	const fit = shrinkResult.fit;
	const droppedRequests = shrinkResult.dropped.map((v) => v.request);

	const composed = intersectTxWindows(fit.map((v) => v.window));
	if (composed == null) {
		logger.error('V2 collection composed window is null after shrink — falling back', { walletId: wallet.id });
		await fallbackToSingleItems(
			validated.map((v) => v.request),
			paymentContract,
			blockchainProvider,
			network,
		);
		return;
	}

	const items: BatchWithdrawItem[] = fit.map((v) => ({
		type: 'CollectCompleted',
		smartContractUtxo: v.smartContractUtxo,
		collection: {
			collectAssets: v.collectAssets,
			collectionAddress: v.collectionAddress,
		},
		fee: null,
		collateralReturn: {
			lovelace: v.collateralReturn.lovelace,
			address: v.collateralReturn.address,
		},
		// V2 contract requires per-input outputs (collection + collateral
		// return) to be tagged with own_ref so the validator can match each
		// tagged output to its specific spending input.
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
		assertTxSizeWithinLimit(unsignedTx, 'v2-collection-batch');
	} catch (batchError) {
		logger.warn('V2 collection batch build failed; falling back to single-item [batch-fallback]', {
			error:
				batchError instanceof Error
					? { message: batchError.message, stack: batchError.stack, name: batchError.name }
					: batchError,
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
		logger.warn('V2 collection batch sign failed; falling back to single-item [batch-fallback]', {
			error:
				signError instanceof Error
					? { message: signError.message, stack: signError.stack, name: signError.name }
					: signError,
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

	// V2 batch shared-Transaction pre-submit:
	// 1. Create ONE Transaction row carrying BlocksWallet → wallet.
	// 2. Connect every fit item's CurrentTransaction to that shared Tx.
	// This replaces the N-orphan pattern (one createPendingTransaction per
	// item) — HotWallet.pendingTransactionId points to the single shared Tx,
	// so tx-sync's BlocksWallet-driven wallet unlock fires exactly once per
	// batch regardless of which entry it processes first.
	let sharedTxId: string;
	try {
		sharedTxId = await retryOnSerializationConflict(
			() =>
				prisma.$transaction(
					async (tx) => {
						const sharedTx = await tx.transaction.create({
							data: {
								status: TransactionStatus.Pending,
								BlocksWallet: { connect: { id: wallet.id } },
							},
						});
						for (const v of fit) {
							await tx.paymentRequest.update({
								where: { id: v.request.id },
								data: {
									...connectPreviousAction(v.request.nextActionId),
									...createNextPaymentAction(PaymentAction.WithdrawInitiated),
									...connectExistingTransaction(sharedTx.id),
									TransactionHistory: { connect: { id: v.request.CurrentTransaction!.id } },
								},
							});
						}
						return sharedTx.id;
					},
					{ timeout: 30_000 },
				),
			{ label: 'collection-batch-tx' },
		);
	} catch (dbError) {
		logger.error('V2 collection batch DB pre-submit update failed', { error: dbError });
		await unlockHotWallet(wallet.id);
		return;
	}

	let newTxHash: string;
	try {
		newTxHash = await meshWallet.submitTx(signedTx);
	} catch (submitError) {
		logger.warn('V2 collection batch submit failed; rolling back DB and retrying as single items', {
			error:
				submitError instanceof Error
					? { message: submitError.message, stack: submitError.stack, name: submitError.name }
					: submitError,
		});
		await retryOnSerializationConflict(
			() =>
				prisma.$transaction(
					async (tx) => {
						for (const v of fit) {
							await tx.paymentRequest.update({
								where: { id: v.request.id },
								data: {
									...connectPreviousAction(v.request.nextActionId),
									...createNextPaymentAction(PaymentAction.WithdrawRequested),
									CurrentTransaction: {
										update: {
											txHash: v.request.CurrentTransaction!.txHash,
											status: v.request.CurrentTransaction!.status,
											BlocksWallet: { disconnect: true },
										},
									},
									TransactionHistory: { disconnect: { id: v.request.CurrentTransaction!.id } },
								},
							});
						}
					},
					{ timeout: 30_000 },
				),
			{ label: 'collection-batch-tx' },
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
		logger.warn('V2 collection batch projected balance evaluation failed (non-fatal)', { error: balanceError });
	}

	// Post-submit: a SINGLE Transaction row carries the txHash for the whole
	// batch (because pre-submit created one shared Tx referenced by every
	// participating PaymentRequest). One update suffices.
	try {
		await retryOnSerializationConflict(
			() =>
				prisma.$transaction(
					async (tx) => {
						await tx.transaction.update({
							where: { id: sharedTxId },
							data: { txHash: newTxHash },
						});
					},
					{ timeout: 30_000 },
				),
			{ label: 'collection-batch-tx' },
		);
	} catch (dbError) {
		logger.error('V2 collection batch post-submit DB update failed; tx-sync will reconcile next tick', {
			error:
				dbError instanceof Error ? { message: dbError.message, stack: dbError.stack, name: dbError.name } : dbError,
			txHash: newTxHash,
		});
	}

	logger.debug(`Created V2 collection batch transaction:
              Tx ID: ${newTxHash}
              Items: ${fit.length}
              View on https://${network === 'preprod' ? 'preprod.' : ''}cardanoscan.io/transaction/${newTxHash}
              Smart Contract Address: ${smartContractAddress}
          `);

	if (droppedRequests.length > 0) {
		await Promise.allSettled(
			droppedRequests.map((request) =>
				prisma.paymentRequest.update({
					where: { id: request.id },
					data: {
						...connectPreviousAction(request.nextActionId),
						...createNextPaymentAction(PaymentAction.WithdrawRequested),
					},
				}),
			),
		);
	}
}

function groupRequestsByWallet(requests: PaymentRequestWithRelations[]): Map<string, PaymentRequestWithRelations[]> {
	const byWallet = new Map<string, PaymentRequestWithRelations[]>();
	for (const request of requests) {
		if (request.SmartContractWallet == null) continue;
		const list = byWallet.get(request.SmartContractWallet.id) ?? [];
		list.push(request);
		byWallet.set(request.SmartContractWallet.id, list);
	}
	return byWallet;
}

export async function collectOutstandingPaymentsV2() {
	let release: MutexInterface.Releaser | null;
	try {
		release = await tryAcquire(mutex).acquire();
	} catch (e) {
		logger.info('Mutex timeout when locking', { error: e });
		return;
	}

	try {
		const paymentContractsWithTimedUnlocks = await lockAndQueryPayments({
			paymentStatus: PaymentAction.WithdrawRequested,
			resultHash: { not: null },
			unlockTime: { lte: Date.now() - 1000 * 60 * 10 },
			onChainState: { in: [OnChainState.ResultSubmitted] },
			maxBatchSize: COLLECTION_BATCH_SIZE,
			paymentSourceType: PaymentSourceType.Web3CardanoV2,
		});
		const paymentContractsWithAuthorizedWithdrawals = await lockAndQueryPayments({
			paymentStatus: PaymentAction.WithdrawRequested,
			resultHash: { not: null },
			onChainState: { in: [OnChainState.WithdrawAuthorized] },
			paymentSourceType: PaymentSourceType.Web3CardanoV2,
			maxBatchSize: COLLECTION_BATCH_SIZE,
		});
		const paymentContractsWithWalletLocked = [
			...paymentContractsWithTimedUnlocks,
			...paymentContractsWithAuthorizedWithdrawals,
		];

		await Promise.allSettled(
			paymentContractsWithWalletLocked.map(async (paymentContract) => {
				if (paymentContract.PaymentRequests.length == 0) return;

				logger.info(
					`Collecting ${paymentContract.PaymentRequests.length} V2 payments for payment source ${paymentContract.id}`,
				);

				const network = convertNetwork(paymentContract.network);
				const blockchainProvider = await createMeshProvider(paymentContract.PaymentSourceConfig.rpcProviderApiKey);
				const { script, smartContractAddress } = await getPaymentScriptFromPaymentSourceV2(paymentContract);

				const grouped = groupRequestsByWallet(paymentContract.PaymentRequests);
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
		logger.error('Error collecting V2 outstanding payments', { error });
	} finally {
		release();
	}
}
