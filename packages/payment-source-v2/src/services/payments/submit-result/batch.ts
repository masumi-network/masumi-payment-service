import { PaymentAction, TransactionStatus } from '@/generated/prisma/client';
import { prisma } from '@masumi/payment-core/db';
import { resolveTxHash } from '@meshsdk/core';
import { isDefinitiveNodeRejection } from '@masumi/payment-core/submit-error-classifier';
import type { LanguageVersion } from '@meshsdk/core';
import { asV2Provider } from '../../provider-cast';
import type { BlockfrostProvider } from '@/services/shared';
import { logger } from '@masumi/payment-core/logger';
import { recordV2BatchHashDivergence } from '@masumi/payment-core/metrics';
import { retryOnSerializationConflict } from '@masumi/payment-core/db-retry';
import { withMeshCostModelLock } from '@/utils/mesh-cost-model-sync';
import {
	connectExistingNextPaymentAction,
	connectExistingTransaction,
	connectPreviousAction,
	createNextPaymentAction,
	disconnectTransactionWallet,
	loadHotWalletSession,
	safeDeleteOrphanNextPaymentAction,
} from '@/services/shared';
import {
	assertNoCollateralOverlap,
	assertTxSizeWithinLimit,
	getWalletUtxosForSelection,
	intersectTxWindows,
	pickBatchCollateral,
	shrinkBatchToFit,
} from '../../../builders/batch-helpers';
import {
	type BatchInteractionItem,
	generateMasumiSmartContractBatchInteractionTransactionAutomaticFees,
} from '../../../builders/batch-interaction';
import { ensureCollateralReady } from '../../wallet-collateral/ensure-collateral-ready';
import { isLookupDeferred } from '../../lookup-defer';
import { unlockHotWalletIfNoPendingTransaction } from '../../wallet-lock-helpers';
import { type ValidatedSubmitItem, validateAndBuildItem } from './batch-item';
import { markRequestFailed, unlockHotWallet } from './failure';
import { fallbackToSingleItems } from './single';
import type { PaymentRequestWithRelations, PaymentSourceWithRelations } from './types';

/**
 * The L1 batch path for one hot wallet: validate every queued request, build
 * one shared tx, record it before broadcast, submit, and roll back to the
 * single-item fallback on a definitive rejection.
 */
export async function processWalletBatch(
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
			'V2 submit-result batch could not load wallet session; leaving items in pool for next tick [batch-fallback]',
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

	const collateralCheck = await ensureCollateralReady({
		walletDbId: wallet.id,
		walletAddress: address,
		meshWallet,
		utxos,
		blockchainProvider,
		network,
		serviceLabel: 'submit-result-batch',
	});
	if (collateralCheck.status !== 'ready') {
		// Helper has either submitted a prep tx (deferred — wallet locked
		// until prep confirms) or hit insufficient_funds / prep_tx_failed.
		// Either way leave items queued and bail out of this tick.
		return;
	}

	// Per-request validation. Failures here become per-request DB failures and
	// are excluded from the batch.
	const validated: ValidatedSubmitItem[] = [];
	const deferredIds: string[] = [];
	const failedIds: string[] = [];
	for (const request of requests) {
		try {
			validated.push(await validateAndBuildItem(request, paymentContract, blockchainProvider, network));
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
				logger.warn('V2 submit-result: deferring item this tick (chain lookup not ready) [batch-diag]', {
					tickPhase: 'validate',
					requestId: request.id,
					blockchainIdentifier: request.blockchainIdentifier,
					walletId: wallet.id,
					currentTxHash: request.CurrentTransaction?.txHash ?? null,
					error: error instanceof Error ? error.message : error,
				});
			} else {
				failedIds.push(request.id);
				logger.warn('V2 submit-result: marking item as failed (non-defer error) [batch-diag]', {
					requestId: request.id,
					blockchainIdentifier: request.blockchainIdentifier,
					error: error instanceof Error ? { message: error.message, name: error.name } : error,
				});
				// Mid-batch: keep the shared wallet lock (see markRequestFailed).
				await markRequestFailed(request, error, { unlockWallet: false });
			}
		}
	}
	// WARN-level so CI grep captures it. This is the single most useful log
	// for diagnosing 'stuck item' failures in batch-verification e2e.
	logger.warn('V2 submit-result: per-item validation outcome [batch-diag]', {
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
			'No V2 submit-result items in this tick reached the batch builder (every item was either deferred for tx-sync to reconcile or marked failed); leaving wallet unlocked',
			{ walletId: wallet.id, deferredIds, failedIds },
		);
		await unlockHotWallet(wallet.id, wallet.lockedAt);
		return;
	}

	// Pick collateral that is NOT in the spending set.
	const excludeRefs = validated.map((v) => v.smartContractUtxo.input);
	const collateralUtxo = pickBatchCollateral(utxos, excludeRefs);
	if (collateralUtxo == null) {
		logger.warn('V2 submit-result batch could not find collateral UTxO; falling back to single-item [batch-fallback]', {
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

	const walletUtxos = getWalletUtxosForSelection(
		utxos,
		validated.map((v) => v.smartContractUtxo.input),
	);
	// Constraints applied progressively: validity-window intersection then
	// no-collateral-overlap. tx-size is checked after the build pass.
	const shrinkResult = shrinkBatchToFit(validated, (subset) => {
		const window = intersectTxWindows(subset.map((v) => v.window));
		if (window == null) {
			return { ok: false, reason: 'window' };
		}
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
			'V2 submit-result batch could not satisfy batch invariants; falling back to single-item [batch-fallback]',
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
			`V2 submit-result batch shrunk from ${validated.length} to ${shrinkResult.fit.length} (reason=${shrinkResult.reason})`,
		);
	}

	const fit = shrinkResult.fit;
	const droppedRequests = shrinkResult.dropped.map((v) => v.request);

	// Composed window from the surviving subset.
	const composed = intersectTxWindows(fit.map((v) => v.window));
	if (composed == null) {
		// shrinkBatchToFit invariant says this can't happen for fit.length > 0,
		// but be defensive.
		logger.error('V2 submit-result composed window is null after shrink — falling back', { walletId: wallet.id });
		await fallbackToSingleItems(
			validated.map((v) => v.request),
			paymentContract,
			blockchainProvider,
			network,
		);
		return;
	}

	const items: BatchInteractionItem[] = fit.map((v) => ({
		type: 'SubmitResult',
		smartContractUtxo: v.smartContractUtxo,
		newInlineDatum: v.newInlineDatum,
	}));

	let unsignedTx: string;
	try {
		// See note on cross-mesh-version type alias in
		// packages/payment-source-v2/src/services/registry/deregister/service.ts.
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
		assertTxSizeWithinLimit(unsignedTx, 'v2-submit-result-batch');
	} catch (batchError) {
		logger.warn('V2 submit-result batch build failed; falling back to single-item [batch-fallback]', {
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
		logger.warn('V2 submit-result batch sign failed; falling back to single-item [batch-fallback]', {
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
	// Captured per-request Initiated NextAction ids; used by the rollback path
	// below to safely delete the orphan rows without risking accidental deletion
	// of someone else's history entry (see safeDeleteOrphanNextPaymentAction).
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
							// Explicit create-then-connect so we know the new *Initiated row's id.
							// The default `createNextPaymentAction` does a nested create whose id
							// isn't directly returned; we need it to safely clean up orphans on
							// rollback (see #6 audit-trail leak design).
							const initiated = await tx.paymentActionData.create({
								data: {
									requestedAction: PaymentAction.SubmitResultInitiated,
									resultHash: v.request.NextAction.resultHash,
								},
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
					{ isolationLevel: 'Serializable', timeout: 30_000, maxWait: 30_000 },
				),
			{ label: 'submit-result-batch-tx' },
		);
	} catch (dbError) {
		logger.error('V2 submit-result batch DB pre-submit update failed', { error: dbError });
		await unlockHotWallet(wallet.id, wallet.lockedAt);
		return;
	}

	// Defensive: record `intendedTxHash` + `invalidHereafterSlot` on the
	// shared Transaction row BEFORE broadcast. If submit later throws
	// AMBIGUOUSLY (transport error, 5xx, timeout — unknown chain outcome)
	// we leave the row Pending; funding-reconciliation resolves it by
	// querying the chain for `intendedTxHash` once `invalidHereafterSlot`
	// has passed. Without the hash recorded, reconciliation cannot resolve
	// and the Pending row sits until wallet-timeouts forces a manual sweep.
	// See batch-payments service header for the full invariant.
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
			{ label: 'submit-result-batch-record-intended' },
		);
	} catch (recordError) {
		logger.error('V2 submit-result batch could not record intendedTxHash; will rollback pre-submit DB', {
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
		// definitively (found → promote, not-found AND past
		// invalidHereafterSlot → RolledBack).
		// recordIntentFailed forces the rollback branch (we never broadcast).
		const definitive = recordIntentFailed || isDefinitiveNodeRejection(submitError);
		if (!definitive) {
			logger.warn('V2 submit-result batch submit AMBIGUOUS; leaving Pending for reconciliation', {
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
		logger.warn('V2 submit-result batch submit definitively rejected; rolling back DB and retrying as single items', {
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
									`V2 submit-result rollback: request ${v.request.id} missing CurrentTransaction; skipping item revert`,
								);
								continue;
							}
							// Drift check: confirm the request's NextAction is still OUR *Initiated.
							// If another worker advanced it (manual recovery, concurrent tick),
							// LEAVE THE ROW ALONE — don't revert state and don't delete the
							// Initiated row. Conservative: better to leak the row than corrupt
							// someone else's history. See #6 audit-trail leak design.
							const expectedInitiatedId = initiatedByRequestId.get(v.request.id);
							const fresh = await tx.paymentRequest.findUnique({
								where: { id: v.request.id },
								select: { nextActionId: true },
							});
							if (expectedInitiatedId == null || fresh == null || fresh.nextActionId !== expectedInitiatedId) {
								logger.warn(
									'V2 submit-result rollback: nextAction drifted after pre-submit; leaving Initiated row, skipping revert',
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
									// NOTE: NO connectPreviousAction(v.request.nextActionId) here.
									// Pre-submit already wrote the OLD *Requested into ActionHistory;
									// re-running would be a no-op (Prisma `connect` semantics on a
									// many-to-many) and is misleading.
									...createNextPaymentAction(PaymentAction.SubmitResultRequested, {
										errorType: null,
										errorNote: null,
										resultHash: v.request.NextAction.resultHash,
									}),
									CurrentTransaction: { connect: { id: currentTxId } },
									TransactionHistory: { disconnect: { id: currentTxId } },
								},
							});
							// Safely delete the orphan *Initiated row created in pre-submit.
							// The helper re-verifies inside this Serializable tx that the row
							// has zero incoming references; if it does, it leaks the row and
							// returns reason. Caller logs at WARN — leaking a row is a minor
							// audit drift; deleting one referenced elsewhere is corruption.
							const result = await safeDeleteOrphanNextPaymentAction(tx, expectedInitiatedId);
							if (!result.deleted) {
								logger.warn('V2 submit-result rollback: leaked orphan Initiated row (refused to delete)', {
									requestId: v.request.id,
									orphanActionId: expectedInitiatedId,
									reason: result.reason,
								});
							}
						}
					},
					{ isolationLevel: 'Serializable', timeout: 30_000, maxWait: 30_000 },
				),
			{ label: 'submit-result-batch-tx' },
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
		await unlockHotWalletIfNoPendingTransaction(wallet.id, 'submit-result-batch-rollback');
		return;
	}

	// Divergence check: if mesh returned a hash different from the
	// deterministically-computed intendedTxHash, the tx IS still on chain at
	// the node-returned hash (the node is authoritative), but the discrepancy
	// signals a hash-computation drift — investigate cost-model staleness,
	// mesh-version drift, or protocol-parameter desync. Log loudly and bump
	// the dedicated metric for alerting.
	if (newTxHash !== intendedTxHash) {
		logger.error('V2 submit-result batch: node returned divergent txHash — investigate', {
			sharedTxId,
			intendedTxHash,
			nodeTxHash: newTxHash,
			requestIds: fit.map((v) => v.request.id),
		});
		recordV2BatchHashDivergence('submit-result', { source_id: paymentContract.id });
	}

	try {
		await walletSession.evaluateProjectedBalance(unsignedTx, utxos);
	} catch (balanceError) {
		logger.warn('V2 submit-result batch projected balance evaluation failed (non-fatal)', {
			error:
				balanceError instanceof Error
					? { message: balanceError.message, stack: balanceError.stack, name: balanceError.name }
					: balanceError,
		});
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
					{ isolationLevel: 'Serializable', timeout: 30_000, maxWait: 30_000 },
				),
			{ label: 'submit-result-batch-tx' },
		);
	} catch (dbError) {
		logger.error('V2 submit-result batch post-submit DB update failed; tx-sync will reconcile next tick', {
			error:
				dbError instanceof Error ? { message: dbError.message, stack: dbError.stack, name: dbError.name } : dbError,
			txHash: newTxHash,
		});
	}

	// WARN-level so CI grep captures it. Single source of truth for what
	// landed in the on-chain tx vs what got left behind this tick.
	logger.warn('V2 submit-result: batch submitted [batch-diag]', {
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

	logger.debug(`Created V2 submit-result batch transaction:
              Tx ID: ${newTxHash}
              Items: ${fit.length}
              View on https://${network === 'preprod' ? 'preprod.' : ''}cardanoscan.io/transaction/${newTxHash}
              Smart Contract Address: ${smartContractAddress}
          `);

	if (droppedRequests.length > 0) {
		// Items that were peeled off should be retried via single-item next
		// tick. Mark as failed-and-retryable so the scheduler can pick them up.
		await Promise.allSettled(
			droppedRequests.map((request) =>
				prisma.paymentRequest.update({
					where: { id: request.id },
					data: {
						...connectPreviousAction(request.nextActionId),
						...createNextPaymentAction(PaymentAction.SubmitResultRequested, {
							errorType: null,
							errorNote: null,
							resultHash: request.NextAction.resultHash,
						}),
					},
				}),
			),
		);
	}
}
