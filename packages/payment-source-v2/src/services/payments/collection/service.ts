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
import type { LanguageVersion, UTxO } from '@meshsdk/core';
import { asV2Provider } from '../../provider-cast';
import type { BlockfrostProvider } from '@/services/shared';
import { logger } from '@masumi/payment-core/logger';
import { SmartContractState, smartContractStateEqualsOnChainState } from '@/utils/generator/contract-generator';
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
	connectExistingNextPaymentAction,
	connectExistingTransaction,
	connectPreviousAction,
	createMeshProvider,
	createNextPaymentAction,
	createPendingTransaction,
	createTxWindow,
	disconnectTransactionWallet,
	loadHotWalletSession,
	safeDeleteOrphanNextPaymentAction,
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
import { ensureCollateralReady } from '../../wallet-collateral/ensure-collateral-ready';
import { LOOKUP_DEFERRED_PREFIX, isLookupDeferred } from '../../lookup-defer';
import { fetchUTxOsWithDeferOnEmpty } from '../../utxo-fetch-helpers';
import { unlockHotWalletIfNoPendingTransaction } from '../../wallet-lock-helpers';

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

// LOOKUP_DEFERRED_PREFIX / isLookupDeferred imported from ../../lookup-defer.
// Rationale (see lookup-defer.ts): batch services throw with the sentinel
// prefix to signal "skip this item, leave it in *Requested for the next tick"
// rather than parking in WaitingForManualAction. Authority for terminal
// transitions belongs to tx-sync; action services should never short-circuit
// chain-state inference based on a transient blockfrost miss.

// `fetchUTxOsWithDeferOnEmpty` is imported from ../../utxo-fetch-helpers — see
// that file for the retry/backoff rationale.

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

	// Aiken `Withdraw` requires `must_start_after(validity_range, unlock_time)`
	// for the timed path (state == ResultSubmitted). When state ==
	// WithdrawAuthorized the buyer's signature short-circuits the timed gate
	// and no lower bound is needed. Without this constrainAfterMs the default
	// `invalidBefore` (~now - 2.5 min) can land earlier than unlock_time when
	// the scheduler force-advances state, phase-2-failing the tx.
	const { invalidBefore, invalidAfter } = createTxWindow(network, {
		constrainBeforeMs: decodedContract.sellerCooldownTime,
		...(decodedContract.state === SmartContractState.WithdrawAuthorized
			? {}
			: { constrainAfterMs: decodedContract.unlockTime }),
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

	// Same collateral-readiness gate as the batch path. Throw the
	// LOOKUP_DEFERRED sentinel when we are NOT ready so the
	// `fallbackToSingleItems` catch arm in this service routes the item
	// back to the queue (via the `info`-level defer log) instead of
	// calling markRequestFailed. The prep tx already locks the wallet
	// through its shared Tx row; we just need the caller to bail out
	// without consuming the slot.
	const collateralCheck = await ensureCollateralReady({
		walletDbId: request.SmartContractWallet.id,
		walletAddress: address,
		meshWallet: wallet,
		utxos,
		blockchainProvider,
		network,
		serviceLabel: 'collection-single',
	});
	if (collateralCheck.status !== 'ready') {
		throw new Error(
			`${LOOKUP_DEFERRED_PREFIX} wallet not collateral-ready (${collateralCheck.status}); retry next tick`,
		);
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
	// Submit FIRST, then write DB. Previous order (DB row → submitTx) left an
	// orphan Pending Transaction row holding BlocksWallet → wallet whenever
	// submitTx threw: the wallet stayed locked via HotWallet.pendingTransactionId
	// until wallet-timeouts swept it minutes later. With submit-first, a
	// pre-submit throw leaves NO Tx row to clean up; the caller's catch arm
	// (markRequestFailed) is responsible for clearing lockedAt. A post-submit
	// throw leaves the Tx row in place (it points at a real on-chain tx) per
	// the user's "do NOT revert after successful submit" constraint.
	//
	// Create a FRESH Transaction row per lifecycle phase rather than mutating
	// the upstream tx in-place. Recycling the prior Transaction row via
	// `CurrentTransaction.update({ txHash: null, status: Pending })` loses the
	// terminal status of the previous phase (e.g. the original submit-result
	// tx is Confirmed; flipping it back to Pending breaks tx-sync's
	// idempotency guards) and entangles two distinct on-chain txs in one DB
	// row. createPendingTransaction makes a new row with BlocksWallet → this
	// wallet, and the prior Transaction id is pushed onto TransactionHistory
	// so the audit trail still shows the submit-result tx.
	const newTxHash = await wallet.submitTx(signedTx);
	await walletSession.evaluateProjectedBalance(unsignedTx, limitedFilteredUtxos);
	// Post-submit DB update: wrap in retryOnSerializationConflict so a transient
	// serialization conflict (concurrent tx-sync writer that just saw this tx
	// land, recovery cron, manual API touch) doesn't bubble up to the outer
	// `advancedRetry` and cause it to re-invoke processSinglePaymentCollection
	// — which would build & submit a SECOND on-chain tx for the same request
	// (input UTxO already consumed → phase-2 fail + ex-units burn). Bare
	// update was the post-submit single-item analog of #2 funding double-lock.
	// Snapshot the wallet id before the closure — TS narrowing of
	// request.SmartContractWallet doesn't survive into the arrow function.
	const smartContractWalletId = request.SmartContractWallet.id;
	await retryOnSerializationConflict(
		() =>
			prisma.paymentRequest.update({
				where: { id: request.id },
				data: {
					...connectPreviousAction(request.nextActionId),
					...createNextPaymentAction(PaymentAction.WithdrawInitiated),
					...createPendingTransaction(smartContractWalletId, newTxHash),
					TransactionHistory: { connect: { id: request.CurrentTransaction!.id } },
				},
			}),
		{ label: 'v2-collection-single-post-submit' },
	);

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

	const collateralCheck = await ensureCollateralReady({
		walletDbId: wallet.id,
		walletAddress: address,
		meshWallet,
		utxos,
		blockchainProvider,
		network,
		serviceLabel: 'collection-batch',
	});
	if (collateralCheck.status !== 'ready') {
		// Helper has either submitted a prep tx (deferred — wallet locked
		// until prep confirms) or hit insufficient_funds / prep_tx_failed.
		// Either way leave items queued and bail out of this tick.
		return;
	}

	const validated: ValidatedCollectionItem[] = [];
	const deferredIds: string[] = [];
	const failedIds: string[] = [];
	for (const request of requests) {
		try {
			validated.push(await validateAndBuildItem(request, blockchainProvider, network, smartContractAddress));
		} catch (error) {
			if (isLookupDeferred(error)) {
				// Chain-lookup miss (blockfrost not caught up, or the UTxO
				// has already been consumed by something tx-sync has not
				// observed yet). Leave the request queued — tx-sync owns
				// the chain-state truth and will drive any terminal
				// transition. WARN-level so the CI grep captures it — this is
				// the most likely path for a 'stuck item' to enter, and we
				// need to be able to count defers per tick from the log dump.
				deferredIds.push(request.id);
				logger.warn('V2 collection: deferring item this tick (chain lookup not ready) [batch-diag]', {
					tickPhase: 'validate',
					requestId: request.id,
					blockchainIdentifier: request.blockchainIdentifier,
					walletId: wallet.id,
					currentTxHash: request.CurrentTransaction?.txHash ?? null,
					error: error instanceof Error ? error.message : error,
				});
			} else {
				failedIds.push(request.id);
				logger.warn('V2 collection: marking item as failed (non-defer error) [batch-diag]', {
					requestId: request.id,
					blockchainIdentifier: request.blockchainIdentifier,
					error: error instanceof Error ? { message: error.message, name: error.name } : error,
				});
				await markRequestFailed(request, error);
			}
		}
	}
	// WARN-level so CI grep captures it. This is the single most useful log
	// for diagnosing 'stuck item' failures in batch-verification e2e.
	logger.warn('V2 collection: per-item validation outcome [batch-diag]', {
		tickPhase: 'validate-summary',
		walletId: wallet.id,
		totalIn: requests.length,
		validatedCount: validated.length,
		deferredCount: deferredIds.length,
		failedCount: failedIds.length,
		validatedIds: validated.map((v) => v.request.blockchainIdentifier),
		deferredIds,
		failedIds,
		inboundIds: requests.map((r) => ({
			blockchainIdentifier: r.blockchainIdentifier,
			currentTxHash: r.CurrentTransaction?.txHash ?? null,
		})),
	});
	if (validated.length === 0) {
		logger.info(
			'No V2 collection items in this tick reached the batch builder (every item was either deferred for tx-sync to reconcile or marked failed); leaving wallet unlocked',
			{ walletId: wallet.id, deferredIds, failedIds },
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
			asV2Provider(blockchainProvider),
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
	// Captured *Initiated NextAction ids; rollback path below uses them to
	// safely delete orphans. See #6 audit-trail leak design.
	const initiatedByRequestId = new Map<string, string>();
	try {
		sharedTxId = await retryOnSerializationConflict(
			() =>
				prisma.$transaction(
					async (tx) => {
						initiatedByRequestId.clear();
						const sharedTx = await tx.transaction.create({
							data: {
								status: TransactionStatus.Pending,
								// `lastCheckedAt: now` required so wallet-timeouts can poll this row.
								// See docs/adr/0006 and docs/adr/0007 for the full rationale.
								lastCheckedAt: new Date(),
								BlocksWallet: { connect: { id: wallet.id } },
							},
						});
						for (const v of fit) {
							const initiated = await tx.paymentActionData.create({
								data: { requestedAction: PaymentAction.WithdrawInitiated },
							});
							await tx.paymentRequest.update({
								where: { id: v.request.id },
								data: {
									...connectPreviousAction(v.request.nextActionId),
									...connectExistingNextPaymentAction(initiated.id),
									...connectExistingTransaction(sharedTx.id),
									TransactionHistory: { connect: { id: v.request.CurrentTransaction!.id } },
								},
							});
							initiatedByRequestId.set(v.request.id, initiated.id);
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
						await tx.transaction.update({
							where: { id: sharedTxId },
							data: {
								...disconnectTransactionWallet(),
								// Mark the orphan shared row as RolledBack: the per-item reverts
								// below restore each request's CurrentTransaction to its pre-batch
								// value, leaving this row with no back-references. Without an
								// explicit status update it would sit in `Pending` indefinitely
								// (no wallet pointer → invisible to wallet-timeouts; no request
								// pointer → invisible to tx-sync), accumulating as DB pollution.
								status: TransactionStatus.RolledBack,
							},
						});
						for (const v of fit) {
							// Skip+log rather than bang-then-throw: a throw here would roll back the
							// shared-Tx revert above. lockedAt is handled separately by the
							// post-fallbackToSingleItems unlockHotWalletIfNoPendingTransaction.
							const currentTxId = v.request.CurrentTransaction?.id;
							if (currentTxId == null) {
								logger.error(
									`V2 collection rollback: request ${v.request.id} missing CurrentTransaction; skipping item revert`,
								);
								continue;
							}
							const expectedInitiatedId = initiatedByRequestId.get(v.request.id);
							const fresh = await tx.paymentRequest.findUnique({
								where: { id: v.request.id },
								select: { nextActionId: true },
							});
							if (expectedInitiatedId == null || fresh == null || fresh.nextActionId !== expectedInitiatedId) {
								logger.warn(
									'V2 collection rollback: nextAction drifted after pre-submit; leaving Initiated row, skipping revert',
									{ requestId: v.request.id, expectedInitiatedId, actualNextAction: fresh?.nextActionId },
								);
								continue;
							}
							await tx.paymentRequest.update({
								where: { id: v.request.id },
								data: {
									...createNextPaymentAction(PaymentAction.WithdrawRequested),
									CurrentTransaction: { connect: { id: currentTxId } },
									TransactionHistory: { disconnect: { id: currentTxId } },
								},
							});
							const result = await safeDeleteOrphanNextPaymentAction(tx, expectedInitiatedId);
							if (!result.deleted) {
								logger.warn('V2 collection rollback: leaked orphan Initiated row (refused to delete)', {
									requestId: v.request.id,
									orphanActionId: expectedInitiatedId,
									reason: result.reason,
								});
							}
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
		// Rollback only cleared pendingTransactionId; lockedAt stays set. Conditional
		// unlock prevents the wallet from orphan-locking when every single-item fallback
		// deferred — preserves the lock when a single-item submit succeeded.
		await unlockHotWalletIfNoPendingTransaction(wallet.id, 'collection-batch-rollback');
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

	// WARN-level so CI grep captures it. Single source of truth for what
	// landed in the on-chain tx vs what got left behind this tick.
	logger.warn('V2 collection: batch submitted [batch-diag]', {
		tickPhase: 'submitted',
		walletId: wallet.id,
		newTxHash,
		sharedTxId,
		fitCount: fit.length,
		fitIds: fit.map((v) => v.request.blockchainIdentifier),
		droppedCount: droppedRequests.length,
		droppedIds: droppedRequests.map((r) => r.blockchainIdentifier),
		deferredIds,
		failedIds,
	});

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
		// Merge the two collection variants — timed (unlockTime elapsed,
		// on-chain ResultSubmitted) and authorized (on-chain WithdrawAuthorized)
		// — into a single lock-and-query roundtrip. Two sequential
		// `lockAndQueryPayments` calls used to serialise: variant A's
		// transaction would lock the wallet, variant B would then see the wallet
		// locked and skip it for the entire tick. With both variants in one OR
		// the same scheduler tick processes both kinds of withdrawal.
		const paymentContractsWithWalletLocked = await lockAndQueryPayments({
			paymentStatus: PaymentAction.WithdrawRequested,
			resultHash: { not: null },
			maxBatchSize: COLLECTION_BATCH_SIZE,
			paymentSourceType: PaymentSourceType.Web3CardanoV2,
			orFilters: [
				// Variant A: timed withdrawal — unlockTime has elapsed and the
				// on-chain UTxO is still ResultSubmitted (seller can collect).
				{
					onChainState: { in: [OnChainState.ResultSubmitted] },
					unlockTime: { lte: Date.now() - 1000 * 60 * 10 },
				},
				// Variant B: authorized withdrawal — buyer already authorized,
				// chain has advanced to WithdrawAuthorized. No time constraint.
				{
					onChainState: { in: [OnChainState.WithdrawAuthorized] },
				},
			],
		});

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
