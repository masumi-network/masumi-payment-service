import {
	OnChainState,
	PaymentAction,
	PaymentErrorType,
	PaymentSourceType,
	Prisma,
	TransactionStatus,
} from '@/generated/prisma/client';
import { prisma } from '@masumi/payment-core/db';
import { deserializeDatum, UTxO } from '@meshsdk/core';
import type { LanguageVersion } from '@meshsdk/core';
import { asV2Provider } from '../../provider-cast';
import type { BlockfrostProvider } from '@/services/shared';
import { logger } from '@masumi/payment-core/logger';
import { SmartContractState, smartContractStateEqualsOnChainState } from '@/utils/generator/contract-generator';
import { convertNetwork } from '@/utils/converter/network-convert';
import { DecodedV1ContractDatum, newCooldownTime } from '@/utils/converter/string-datum-convert';
import { lockAndQueryPayments } from '@/utils/db/lock-and-query-payments';
import { retryOnSerializationConflict } from '@/utils/db/retry';
import { interpretBlockchainError } from '@/utils/errors/blockchain-error-interpreter';
import { advancedRetry, delayErrorResolver } from 'advanced-retry';
import { sortAndLimitUtxos } from '@/utils/utxo';
import { Mutex, tryAcquire, MutexInterface } from 'async-mutex';
import { generateMasumiSmartContractInteractionTransactionAutomaticFees } from '@/utils/generator/transaction-generator';
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
import { ensureCollateralReady } from '../../wallet-collateral/ensure-collateral-ready';
import { LOOKUP_DEFERRED_PREFIX, isLookupDeferred } from '../../lookup-defer';
import { fetchUTxOsWithDeferOnEmpty } from '../../utxo-fetch-helpers';
import { unlockHotWalletIfNoPendingTransaction } from '../../wallet-lock-helpers';

// V2 authorize-refund sizing. Same Aiken validator as submit-result; per-input
// budget is similar so 6 fits well within protocol max-ex-units with headroom.
const AUTHORIZE_REFUND_BATCH_SIZE = 7;

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

type ValidatedAuthorizeRefundItem = {
	request: PaymentRequestWithRelations;
	smartContractUtxo: UTxO;
	decodedContract: DecodedV1ContractDatum;
	newInlineDatum: ReturnType<typeof createDatumFromDecodedContractV2>['value'];
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

async function markRequestFailed(request: PaymentRequestWithRelations, error: unknown): Promise<void> {
	logger.error(`Error authorizing V2 refund ${request.id}`, { error });
	await prisma.paymentRequest.update({
		where: { id: request.id },
		data: {
			...connectPreviousAction(request.nextActionId),
			...createNextPaymentAction(PaymentAction.WaitingForManualAction, {
				errorType: PaymentErrorType.Unknown,
				errorNote: 'Authorizing refund failed: ' + interpretBlockchainError(error),
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
		logger.warn('Failed to unlock V2 authorize-refund hot wallet', { error, walletId });
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
			decodedContract.buyerVkey === request.BuyerWallet!.walletVkey &&
			decodedContract.sellerVkey === request.SmartContractWallet!.walletVkey &&
			decodedContract.buyerAddress === request.BuyerWallet!.walletAddress &&
			decodedContract.sellerAddress === request.SmartContractWallet!.walletAddress &&
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
	paymentContract: PaymentSourceWithRelations,
	blockchainProvider: BlockfrostProvider,
	network: 'mainnet' | 'preprod',
	smartContractAddress: string,
): Promise<ValidatedAuthorizeRefundItem> {
	validatePaymentRequestFields(request);
	const txHash = request.CurrentTransaction!.txHash!;
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
	const datum = createDatumFromDecodedContractV2({
		decodedContract,
		buyerAddress: decodedContract.buyerAddress,
		sellerAddress: decodedContract.sellerAddress,
		blockchainIdentifier: request.blockchainIdentifier,
		resultHash: null,
		newCooldownTimeSeller: newCooldownTime(BigInt(paymentContract.cooldownTime)),
		newCooldownTimeBuyer: BigInt(0),
		state: SmartContractState.RefundAuthorized,
	});
	const { invalidBefore, invalidAfter } = createTxWindow(network, {
		constrainBeforeMs: decodedContract.sellerCooldownTime,
	});
	return {
		request,
		smartContractUtxo: utxo,
		decodedContract,
		newInlineDatum: datum.value,
		window: { invalidBefore, invalidAfter },
	};
}

async function processSinglePaymentRequest(
	request: PaymentRequestWithRelations,
	paymentContract: PaymentSourceWithRelations,
	blockchainProvider: BlockfrostProvider,
	network: 'mainnet' | 'preprod',
): Promise<boolean> {
	validatePaymentRequestFields(request);
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

	// Same collateral-readiness gate as the batch path. Throw the
	// LOOKUP_DEFERRED sentinel when we are NOT ready so the
	// `fallbackToSingleItems` catch arm in this service routes the item
	// back to the queue (via the `info`-level defer log) instead of
	// calling markRequestFailed. The prep tx already locks the wallet
	// through its shared Tx row; we just need the caller to bail out
	// without consuming the slot.
	const collateralCheck = await ensureCollateralReady({
		walletDbId: request.SmartContractWallet!.id,
		walletAddress: address,
		meshWallet: wallet,
		utxos,
		blockchainProvider,
		network,
		serviceLabel: 'authorize-refund-single',
	});
	if (collateralCheck.status !== 'ready') {
		throw new Error(
			`${LOOKUP_DEFERRED_PREFIX} wallet not collateral-ready (${collateralCheck.status}); retry next tick`,
		);
	}

	const { script, smartContractAddress } = await getPaymentScriptFromPaymentSourceV2(paymentContract);
	const txHash = request.CurrentTransaction!.txHash!;
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
	const datum = createDatumFromDecodedContractV2({
		decodedContract,
		buyerAddress: decodedContract.buyerAddress,
		sellerAddress: decodedContract.sellerAddress,
		blockchainIdentifier: request.blockchainIdentifier,
		resultHash: null,
		newCooldownTimeSeller: newCooldownTime(BigInt(paymentContract.cooldownTime)),
		newCooldownTimeBuyer: BigInt(0),
		state: SmartContractState.RefundAuthorized,
	});

	const { invalidBefore, invalidAfter } = createTxWindow(network, {
		constrainBeforeMs: decodedContract.sellerCooldownTime,
	});
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
	const newTxHash = await wallet.submitTx(signedTx);
	await walletSession.evaluateProjectedBalance(unsignedTx, limitedFilteredUtxos);
	// retryOnSerializationConflict — see #24 note in V2 collection:
	// post-submit conflict bubbling to advancedRetry would re-submit.
	await retryOnSerializationConflict(
		() =>
			prisma.paymentRequest.update({
				where: { id: request.id },
				data: {
					...connectPreviousAction(request.nextActionId),
					...createNextPaymentAction(PaymentAction.AuthorizeRefundInitiated),
					...createPendingTransaction(request.SmartContractWallet!.id, newTxHash),
					TransactionHistory: { connect: { id: request.CurrentTransaction!.id } },
				},
			}),
		{ label: 'v2-authorize-refund-single-post-submit' },
	);

	logger.debug(`Created V2 authorize-refund transaction:
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
				const ok = await processSinglePaymentRequest(request, paymentContract, blockchainProvider, network);
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
			'V2 authorize-refund batch could not load wallet session; leaving items in pool for next tick [batch-fallback]',
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
		serviceLabel: 'authorize-refund-batch',
	});
	if (collateralCheck.status !== 'ready') {
		// Helper has either submitted a prep tx (deferred — wallet locked
		// until prep confirms) or hit insufficient_funds / prep_tx_failed.
		// Either way leave items queued and bail out of this tick.
		return;
	}

	const validated: ValidatedAuthorizeRefundItem[] = [];
	const deferredIds: string[] = [];
	const failedIds: string[] = [];
	for (const request of requests) {
		try {
			validated.push(
				await validateAndBuildItem(request, paymentContract, blockchainProvider, network, smartContractAddress),
			);
		} catch (error) {
			if (isLookupDeferred(error)) {
				// Chain-lookup miss (UTxO not on chain yet, datum still old, etc).
				// Tx-sync is responsible for eventually moving this request to a
				// terminal state when chain state changes; until then we leave it
				// queued. WARN-level so the CI grep captures it — this is
				// the most likely path for a 'stuck item' to enter, and we
				// need to be able to count defers per tick from the log dump.
				deferredIds.push(request.id);
				logger.warn('V2 authorize-refund: deferring item this tick (chain lookup not ready) [batch-diag]', {
					tickPhase: 'validate',
					requestId: request.id,
					blockchainIdentifier: request.blockchainIdentifier,
					walletId: wallet.id,
					currentTxHash: request.CurrentTransaction?.txHash ?? null,
					error: error instanceof Error ? error.message : error,
				});
			} else {
				failedIds.push(request.id);
				logger.warn('V2 authorize-refund: marking item as failed (non-defer error) [batch-diag]', {
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
	logger.warn('V2 authorize-refund: per-item validation outcome [batch-diag]', {
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
			'No V2 authorize-refund items in this tick reached the batch builder (every item was either deferred for tx-sync to reconcile or marked failed); leaving wallet unlocked',
			{ walletId: wallet.id, deferredIds, failedIds },
		);
		await unlockHotWallet(wallet.id);
		return;
	}

	const excludeRefs = validated.map((v) => v.smartContractUtxo.input);
	const collateralUtxo = pickBatchCollateral(utxos, excludeRefs);
	if (collateralUtxo == null) {
		logger.warn(
			'V2 authorize-refund batch could not find collateral UTxO; falling back to single-item [batch-fallback]',
			{
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
			'V2 authorize-refund batch could not satisfy batch invariants; falling back to single-item [batch-fallback]',
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
			`V2 authorize-refund batch shrunk from ${validated.length} to ${shrinkResult.fit.length} (reason=${shrinkResult.reason})`,
		);
	}

	const fit = shrinkResult.fit;
	const droppedRequests = shrinkResult.dropped.map((v) => v.request);

	const composed = intersectTxWindows(fit.map((v) => v.window));
	if (composed == null) {
		logger.error('V2 authorize-refund composed window is null after shrink — falling back', { walletId: wallet.id });
		await fallbackToSingleItems(
			validated.map((v) => v.request),
			paymentContract,
			blockchainProvider,
			network,
		);
		return;
	}

	const items: BatchInteractionItem[] = fit.map((v) => ({
		type: 'AuthorizeRefund',
		smartContractUtxo: v.smartContractUtxo,
		newInlineDatum: v.newInlineDatum,
	}));

	let unsignedTx: string;
	try {
		unsignedTx = await generateMasumiSmartContractBatchInteractionTransactionAutomaticFees(
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
		assertTxSizeWithinLimit(unsignedTx, 'v2-authorize-refund-batch');
	} catch (batchError) {
		logger.warn('V2 authorize-refund batch build failed; falling back to single-item [batch-fallback]', {
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
		logger.warn('V2 authorize-refund batch sign failed; falling back to single-item [batch-fallback]', {
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
	// safely delete orphans without risking deletion of a row referenced
	// elsewhere. See #6 audit-trail leak design.
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
								data: { requestedAction: PaymentAction.AuthorizeRefundInitiated },
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
			{ label: 'authorize-refund-batch-tx' },
		);
	} catch (dbError) {
		logger.error('V2 authorize-refund batch DB pre-submit update failed', { error: dbError });
		await unlockHotWallet(wallet.id);
		return;
	}

	let newTxHash: string;
	try {
		newTxHash = await meshWallet.submitTx(signedTx);
	} catch (submitError) {
		logger.warn('V2 authorize-refund batch submit failed; rolling back DB and retrying as single items', {
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
							// shared-Tx revert above, so the item state machine would not be returned
							// to *Requested for the next tick. The validator gate upstream means this
							// branch should never fire in practice; lockedAt is handled separately by
							// the post-fallbackToSingleItems unlockHotWalletIfNoPendingTransaction.
							const currentTxId = v.request.CurrentTransaction?.id;
							if (currentTxId == null) {
								logger.error(
									`V2 authorize-refund rollback: request ${v.request.id} missing CurrentTransaction; skipping item revert`,
								);
								continue;
							}
							// Drift check: only revert + delete if NextAction is still OUR *Initiated.
							const expectedInitiatedId = initiatedByRequestId.get(v.request.id);
							const fresh = await tx.paymentRequest.findUnique({
								where: { id: v.request.id },
								select: { nextActionId: true },
							});
							if (expectedInitiatedId == null || fresh == null || fresh.nextActionId !== expectedInitiatedId) {
								logger.warn(
									'V2 authorize-refund rollback: nextAction drifted after pre-submit; leaving Initiated row, skipping revert',
									{
										requestId: v.request.id,
										expectedInitiatedId,
										actualNextAction: fresh?.nextActionId,
									},
								);
								continue;
							}
							await tx.paymentRequest.update({
								where: { id: v.request.id },
								data: {
									// NOTE: pre-submit already connected OLD *Requested into ActionHistory.
									...createNextPaymentAction(PaymentAction.AuthorizeRefundRequested),
									CurrentTransaction: { connect: { id: currentTxId } },
									TransactionHistory: { disconnect: { id: currentTxId } },
								},
							});
							const result = await safeDeleteOrphanNextPaymentAction(tx, expectedInitiatedId);
							if (!result.deleted) {
								logger.warn('V2 authorize-refund rollback: leaked orphan Initiated row (refused to delete)', {
									requestId: v.request.id,
									orphanActionId: expectedInitiatedId,
									reason: result.reason,
								});
							}
						}
					},
					{ timeout: 30_000 },
				),
			{ label: 'authorize-refund-batch-tx' },
		);
		await fallbackToSingleItems(
			validated.map((v) => v.request),
			paymentContract,
			blockchainProvider,
			network,
		);
		// Rollback only cleared pendingTransactionId; lockedAt from lockAndQueryPayments
		// stays set. If every single-item attempt deferred (LOOKUP_DEFERRED), no item
		// cleared lockedAt and the wallet would orphan-lock for WALLET_LOCK_TIMEOUT_INTERVAL.
		// Conditional unlock preserves the lock when a single-item submit succeeded.
		await unlockHotWalletIfNoPendingTransaction(wallet.id, 'authorize-refund-batch-rollback');
		return;
	}

	try {
		await walletSession.evaluateProjectedBalance(unsignedTx, limitedFilteredUtxos);
	} catch (balanceError) {
		logger.warn('V2 authorize-refund batch projected balance evaluation failed (non-fatal)', { error: balanceError });
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
			{ label: 'authorize-refund-batch-tx' },
		);
	} catch (dbError) {
		logger.error('V2 authorize-refund batch post-submit DB update failed; tx-sync will reconcile next tick', {
			error:
				dbError instanceof Error ? { message: dbError.message, stack: dbError.stack, name: dbError.name } : dbError,
			txHash: newTxHash,
		});
	}

	// WARN-level so CI grep captures it. Single source of truth for what
	// landed in the on-chain tx vs what got left behind this tick.
	logger.warn('V2 authorize-refund: batch submitted [batch-diag]', {
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

	logger.debug(`Created V2 authorize-refund batch transaction:
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
						...createNextPaymentAction(PaymentAction.AuthorizeRefundRequested),
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

export async function authorizeRefundV2() {
	let release: MutexInterface.Releaser | null;
	try {
		release = await tryAcquire(mutex).acquire();
	} catch (e) {
		logger.info('Mutex timeout when locking', { error: e });
		return;
	}

	try {
		// vested_pay.ak permits AuthorizeRefund from BOTH `RefundRequested` (no result
		// yet) AND `Disputed` (result already submitted). Earlier versions of this
		// worker only picked Disputed, which stranded any item where the seller
		// authorized a refund before submitting a result — the API at
		// `src/routes/api/payments/authorize-refund/index.ts` accepts that case.
		// `resultHash` is intentionally NOT filtered: RefundRequested items legitimately
		// have a null `resultHash`.
		const paymentContractsWithWalletLocked = await lockAndQueryPayments({
			paymentStatus: PaymentAction.AuthorizeRefundRequested,
			onChainState: { in: [OnChainState.Disputed, OnChainState.RefundRequested] },
			maxBatchSize: AUTHORIZE_REFUND_BATCH_SIZE,
			paymentSourceType: PaymentSourceType.Web3CardanoV2,
		});

		await Promise.allSettled(
			paymentContractsWithWalletLocked.map(async (paymentContract) => {
				if (paymentContract.PaymentRequests.length == 0) return;

				const network = convertNetwork(paymentContract.network);
				logger.info(
					`Authorizing ${paymentContract.PaymentRequests.length} V2 refunds for payment source ${paymentContract.id}`,
				);
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
		logger.error('Error authorizing V2 refunds', { error });
	} finally {
		release();
	}
}
