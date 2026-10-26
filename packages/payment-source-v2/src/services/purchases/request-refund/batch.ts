import { PurchasingAction, TransactionStatus } from '@/generated/prisma/client';
import type { BlockfrostProvider } from '@/services/shared';
import { getCachedChainProtocolParameters, withMeshCostModelLock } from '@/utils/mesh-cost-model-sync';
import { prisma } from '@masumi/payment-core/db';
import { retryOnSerializationConflict } from '@masumi/payment-core/db-retry';
import { logger } from '@masumi/payment-core/logger';
import { recordV2BatchHashDivergence } from '@masumi/payment-core/metrics';
import { isDefinitiveNodeRejection } from '@masumi/payment-core/submit-error-classifier';
import type { LanguageVersion } from '@meshsdk/core';
import { resolveTxHash } from '@meshsdk/core';
import { advancedRetry, delayErrorResolver } from 'advanced-retry';
import { asV2Provider } from '../../provider-cast';
import {
	connectExistingNextPurchaseAction,
	connectExistingTransaction,
	connectPreviousAction,
	createNextPurchaseAction,
	disconnectTransactionWallet,
	loadHotWalletSession,
	safeDeleteOrphanNextPurchaseAction,
} from '@/services/shared';
import {
	assertNoCollateralOverlap,
	assertSignedL1TxSizeWithinProtocolLimit,
	getWalletUtxosForSelection,
	intersectTxWindows,
	pickBatchCollateral,
	shrinkBatchToFit,
} from '../../../builders/batch-helpers';
import {
	type BatchInteractionItem,
	generateMasumiSmartContractBatchInteractionTransactionAutomaticFees,
} from '../../../builders/batch-interaction';
import { isLookupDeferred } from '../../lookup-defer';
import { ensureCollateralReady } from '../../wallet-collateral/ensure-collateral-ready';
import { unlockHotWalletIfNoPendingTransaction } from '../../wallet-lock-helpers';

import type {
	PaymentSourceWithPurchaseRelations,
	PurchaseRequestWithRelations,
	ValidatedRequestRefundItem,
} from './service';
import { markRequestFailed, processSinglePurchaseRequest, unlockHotWallet, validateAndBuildItem } from './single';

async function fallbackToSingleItems(
	requests: PurchaseRequestWithRelations[],
	paymentContract: PaymentSourceWithPurchaseRelations,
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
				const ok = await processSinglePurchaseRequest(request, paymentContract, blockchainProvider, network);
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

export async function processWalletBatch(
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
		logger.warn(
			'V2 request-refund batch could not load wallet session; leaving items in pool for next tick [batch-fallback]',
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
		await unlockHotWallet(wallet.id, wallet.lockedAt);
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
		await unlockHotWallet(wallet.id, wallet.lockedAt);
		return;
	}

	// Cardano allows a VKey wallet UTxO to appear in both `inputs` and
	// `collateral_inputs`; only script-locked UTxOs are invalid collateral.
	// The readiness helper still keeps an additional confirmed UTxO for
	// predictable next-tick readiness, while Mesh may use the declared
	// collateral for regular funding. If the wallet has collapsed to a single
	// UTxO, submit a self-send prep tx and defer the batch. ensureCollateralReady leaves
	// the wallet locked (via its shared Tx row) when it returns
	// 'deferred' or 'failed'; wallet-timeouts / tx-sync will release the
	// lock once the prep tx confirms or times out.
	const collateralCheck = await ensureCollateralReady({
		walletDbId: wallet.id,
		walletAddress: address,
		meshWallet,
		utxos,
		blockchainProvider,
		network,
		serviceLabel: 'request-refund',
	});
	if (collateralCheck.status !== 'ready') {
		return;
	}

	const validated: ValidatedRequestRefundItem[] = [];
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
				// terminal state when chain state changes; until then we leave
				// it queued. WARN-level so the CI grep captures it — this is
				// the most likely path for a 'stuck item' to enter, and we
				// need to be able to count defers per tick from the log dump.
				deferredIds.push(request.id);
				logger.warn('V2 request-refund: deferring item this tick (chain lookup not ready) [batch-diag]', {
					tickPhase: 'validate',
					requestId: request.id,
					blockchainIdentifier: request.blockchainIdentifier,
					walletId: wallet.id,
					currentTxHash: request.CurrentTransaction?.txHash ?? null,
					error: error instanceof Error ? error.message : error,
				});
			} else {
				failedIds.push(request.id);
				logger.warn('V2 request-refund: marking item as failed (non-defer error) [batch-diag]', {
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
	logger.warn('V2 request-refund: per-item validation outcome [batch-diag]', {
		tickPhase: 'validate-summary',
		walletId: wallet.id,
		totalIn: requests.length,
		validatedCount: validated.length,
		deferredCount: deferredIds.length,
		failedCount: failedIds.length,
		validatedIds: validated.map((v) => v.request.blockchainIdentifier),
		deferredIds,
		failedIds,
		// Each candidate's CurrentTransaction.txHash so we can see WHICH
		// submit-result-tx UTxO the validate step is trying to look up.
		inboundIds: requests.map((r) => ({
			blockchainIdentifier: r.blockchainIdentifier,
			currentTxHash: r.CurrentTransaction?.txHash ?? null,
		})),
	});
	if (validated.length === 0) {
		logger.info(
			'No V2 request-refund items in this tick reached the batch builder (every item was either deferred for tx-sync to reconcile or marked failed); leaving wallet unlocked',
			{ walletId: wallet.id, deferredIds, failedIds },
		);
		await unlockHotWallet(wallet.id, wallet.lockedAt);
		return;
	}

	const excludeRefs = validated.map((v) => v.smartContractUtxo.input);
	const collateralUtxo = pickBatchCollateral(utxos, excludeRefs);
	if (collateralUtxo == null) {
		logger.warn(
			'V2 request-refund batch could not find collateral UTxO; falling back to single-item [batch-fallback]',
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

	const walletUtxos = getWalletUtxosForSelection(
		utxos,
		validated.map((v) => v.smartContractUtxo.input),
	);
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
			'V2 request-refund batch could not satisfy batch invariants; falling back to single-item [batch-fallback]',
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
		logger.warn('V2 request-refund batch shrunk [batch-diag]', {
			tickPhase: 'shrink',
			walletId: wallet.id,
			validatedCount: validated.length,
			fitCount: shrinkResult.fit.length,
			droppedCount: shrinkResult.dropped.length,
			reason: shrinkResult.reason,
			fitIds: shrinkResult.fit.map((v) => v.request.blockchainIdentifier),
			droppedIds: shrinkResult.dropped.map((v) => v.request.blockchainIdentifier),
		});
	} else {
		// WARN so CI grep picks this up. Confirms shrink succeeded with no drops.
		logger.warn('V2 request-refund batch composition [batch-diag]', {
			tickPhase: 'shrink',
			walletId: wallet.id,
			fitCount: shrinkResult.fit.length,
			fitIds: shrinkResult.fit.map((v) => v.request.blockchainIdentifier),
		});
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
		unsignedTx = await withMeshCostModelLock(
			paymentContract.PaymentSourceConfig.rpcProviderApiKey,
			async () =>
				await generateMasumiSmartContractBatchInteractionTransactionAutomaticFees(
					asV2Provider(blockchainProvider),
					network,
					script,
					address,
					collateralUtxo,
					walletUtxos,
					items,
					composed.invalidBefore,
					composed.invalidAfter,
					paymentContract.PaymentSourceConfig.rpcProviderApiKey,
				),
		);
		// WARN so CI grep picks this up. The signed size is checked below.
		logger.warn('V2 request-refund batch tx built [batch-diag]', {
			tickPhase: 'built',
			walletId: wallet.id,
			itemCount: items.length,
			txByteSize: unsignedTx.length / 2,
		});
	} catch (batchError) {
		logger.warn('V2 request-refund batch build failed; falling back to single-item [batch-fallback]', {
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
		const protocolParameters =
			getCachedChainProtocolParameters(paymentContract.PaymentSourceConfig.rpcProviderApiKey) ??
			(await blockchainProvider.fetchProtocolParameters(Number.NaN));
		assertSignedL1TxSizeWithinProtocolLimit(signedTx, protocolParameters, 'v2-request-refund-batch');
	} catch (signError) {
		logger.warn('V2 request-refund batch sign or size check failed; falling back to single-item [batch-fallback]', {
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
	logger.warn('V2 request-refund batch tx signed [batch-diag]', {
		tickPhase: 'signed',
		walletId: wallet.id,
	});

	// V2 batch shared-Transaction pre-submit:
	// 1. Create ONE Transaction row carrying BlocksWallet → wallet.
	// 2. Connect every fit item's CurrentTransaction to that shared Tx.
	// This replaces the N-orphan pattern (one createPendingTransaction per
	// item) — HotWallet.pendingTransactionId points to the single shared Tx,
	// so tx-sync's BlocksWallet-driven wallet unlock fires exactly once per
	// batch regardless of which entry it processes first.
	let sharedTxId: string;
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
							const initiated = await tx.purchaseActionData.create({
								data: { requestedAction: PurchasingAction.SetRefundRequestedInitiated },
							});
							await tx.purchaseRequest.update({
								where: { id: v.request.id },
								data: {
									...connectPreviousAction(v.request.nextActionId),
									...connectExistingNextPurchaseAction(initiated.id),
									...connectExistingTransaction(sharedTx.id),
									TransactionHistory: { connect: { id: v.request.CurrentTransaction!.id } },
								},
							});
							initiatedByRequestId.set(v.request.id, initiated.id);
						}
						return sharedTx.id;
					},
					{ isolationLevel: 'Serializable', timeout: 30_000, maxWait: 30_000 },
				),
			{ label: 'request-refund-batch-tx' },
		);
	} catch (dbError) {
		logger.error('V2 request-refund batch DB pre-submit update failed', { error: dbError });
		await unlockHotWallet(wallet.id, wallet.lockedAt);
		return;
	}

	// Defensive: record `intendedTxHash` + `invalidHereafterSlot` on the
	// shared Transaction row BEFORE broadcast. If submit later throws
	// AMBIGUOUSLY (transport error, 5xx, timeout — unknown chain outcome)
	// we leave the row Pending; funding-reconciliation resolves it by
	// querying the chain for `intendedTxHash` once `invalidHereafterSlot`
	// has passed. See batch-payments service header for full invariant.
	const intendedTxHash = resolveTxHash(signedTx);
	const invalidHereafterSlot = composed.invalidAfter;
	let recordIntentFailed = false;
	try {
		await retryOnSerializationConflict(
			() =>
				prisma.transaction.update({
					where: { id: sharedTxId },
					data: {
						intendedTxHash,
						invalidHereafterSlot: BigInt(invalidHereafterSlot),
						lastCheckedAt: new Date(),
					},
				}),
			{ label: 'request-refund-batch-record-intended' },
		);
	} catch (recordError) {
		logger.error('V2 request-refund batch could not record intendedTxHash; will rollback pre-submit DB', {
			sharedTxId,
			intendedTxHash,
			error: recordError instanceof Error ? recordError.message : recordError,
		});
		recordIntentFailed = true;
	}

	let newTxHash: string;
	try {
		if (recordIntentFailed) {
			// Skip broadcast and go to rollback. We have NOT submitted, so DB
			// rollback is safe and the rollback branch below handles it.
			throw new Error('PRE_SUBMIT_RECORD_INTENT_FAILED');
		}
		newTxHash = await meshWallet.submitTx(signedTx);
	} catch (submitError) {
		// Classify: definitive node rejection → safe to rollback DB state.
		// Ambiguous (transport error, network glitch, 5xx) → tx body may be
		// on chain. Leave the shared Transaction Pending with intendedTxHash
		// set; funding-reconciliation resolves once chain reports
		// definitively. recordIntentFailed forces rollback (never broadcast).
		const definitive = recordIntentFailed || isDefinitiveNodeRejection(submitError);
		if (!definitive) {
			logger.warn('V2 request-refund batch submit AMBIGUOUS; leaving Pending for reconciliation', {
				sharedTxId,
				intendedTxHash,
				invalidHereafterSlot,
				error:
					submitError instanceof Error
						? { message: submitError.message, stack: submitError.stack, name: submitError.name }
						: submitError,
			});
			// Wallet stays locked; PendingTransaction stays attached. The
			// funding-reconciliation worker handles the row from here.
			return;
		}
		logger.warn('V2 request-refund batch submit definitively rejected; rolling back DB and retrying as single items', {
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
									`V2 request-refund rollback: request ${v.request.id} missing CurrentTransaction; skipping item revert`,
								);
								continue;
							}
							const expectedInitiatedId = initiatedByRequestId.get(v.request.id);
							const fresh = await tx.purchaseRequest.findUnique({
								where: { id: v.request.id },
								select: { nextActionId: true },
							});
							if (expectedInitiatedId == null || fresh == null || fresh.nextActionId !== expectedInitiatedId) {
								logger.warn(
									'V2 request-refund rollback: nextAction drifted after pre-submit; leaving Initiated row, skipping revert',
									{ requestId: v.request.id, expectedInitiatedId, actualNextAction: fresh?.nextActionId },
								);
								continue;
							}
							await tx.purchaseRequest.update({
								where: { id: v.request.id },
								data: {
									...createNextPurchaseAction(PurchasingAction.SetRefundRequestedRequested),
									CurrentTransaction: { connect: { id: currentTxId } },
									TransactionHistory: { disconnect: { id: currentTxId } },
								},
							});
							const result = await safeDeleteOrphanNextPurchaseAction(tx, expectedInitiatedId);
							if (!result.deleted) {
								logger.warn('V2 request-refund rollback: leaked orphan Initiated row (refused to delete)', {
									requestId: v.request.id,
									orphanActionId: expectedInitiatedId,
									reason: result.reason,
								});
							}
						}
					},
					{ isolationLevel: 'Serializable', timeout: 30_000, maxWait: 30_000 },
				),
			{ label: 'request-refund-batch-tx' },
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
		await unlockHotWalletIfNoPendingTransaction(wallet.id, 'request-refund-batch-rollback');
		return;
	}

	// Divergence check: if mesh returned a hash different from the
	// deterministically-computed intendedTxHash, the tx IS still on chain at
	// the node-returned hash (the node is authoritative), but the discrepancy
	// signals a hash-computation drift — investigate cost-model staleness,
	// mesh-version drift, or protocol-parameter desync. Log loudly and bump
	// the dedicated metric for alerting.
	if (newTxHash !== intendedTxHash) {
		logger.error('V2 request-refund batch: node returned divergent txHash — investigate', {
			sharedTxId,
			intendedTxHash,
			nodeTxHash: newTxHash,
			requestIds: fit.map((v) => v.request.id),
		});
		recordV2BatchHashDivergence('request-refund', { source_id: paymentContract.id });
	}

	try {
		await walletSession.evaluateProjectedBalance(unsignedTx, utxos);
	} catch (balanceError) {
		logger.warn('V2 request-refund batch projected balance evaluation failed (non-fatal)', { error: balanceError });
	}

	// Post-submit: a SINGLE Transaction row carries the txHash for the whole
	// batch (because pre-submit created one shared Tx referenced by every
	// participating PurchaseRequest). One update suffices.
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
					{ isolationLevel: 'Serializable', timeout: 30_000, maxWait: 30_000 },
				),
			{ label: 'request-refund-batch-tx' },
		);
	} catch (dbError) {
		logger.error('V2 request-refund batch post-submit DB update failed; tx-sync will reconcile next tick', {
			error:
				dbError instanceof Error ? { message: dbError.message, stack: dbError.stack, name: dbError.name } : dbError,
			txHash: newTxHash,
		});
	}

	// WARN-level so CI grep captures it. Single source of truth for what
	// landed in the on-chain tx vs what got left behind this tick.
	logger.warn('V2 request-refund batch submitted [batch-diag]', {
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
					},
				}),
			),
		);
	}
}
