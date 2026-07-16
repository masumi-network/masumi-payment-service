import { PurchasingAction, TransactionStatus } from '@/generated/prisma/client';
import { prisma } from '@masumi/payment-core/db';
import { logger } from '@masumi/payment-core/logger';
import { getBlockfrostInstance } from '@/utils/blockfrost';
import { retryOnSerializationConflict } from '@masumi/payment-core/db-retry';
import { withSerializableSlotRetry } from '@masumi/payment-core/serializable-semaphore';

// Reverting an ambiguous submit must resume the SAME sub-flow the request was
// in, not blindly reset to funding. `intendedTxHash` is set by batch-payments
// (FundsLockingInitiated), by the refund/withdraw services, AND by
// collateral-prep on behalf of any of them — so a dependent PurchaseRequest can
// be mid-refund or mid-withdrawal. Map its in-flight `*Initiated` action back to
// the matching `*Requested` action that re-triggers its cron. Resetting a
// refund/withdraw request to `FundsLockingRequested` (the old behaviour) matched
// no cron and silently dropped the refund, letting the on-chain unlock window
// lapse (H5).
const REVERT_REQUEUE_ACTION: Partial<Record<PurchasingAction, PurchasingAction>> = {
	[PurchasingAction.FundsLockingInitiated]: PurchasingAction.FundsLockingRequested,
	[PurchasingAction.SetRefundRequestedInitiated]: PurchasingAction.SetRefundRequestedRequested,
	[PurchasingAction.UnSetRefundRequestedInitiated]: PurchasingAction.UnSetRefundRequestedRequested,
	[PurchasingAction.WithdrawRefundInitiated]: PurchasingAction.WithdrawRefundRequested,
	[PurchasingAction.AuthorizeWithdrawalInitiated]: PurchasingAction.AuthorizeWithdrawalRequested,
};

/**
 * Reconciliation worker for V2 funding transactions whose submit outcome was
 * ambiguous (the submitTx call threw, but the throw didn't prove the chain
 * didn't accept the tx — e.g. TCP reset, gateway 504, blockfrost timeout).
 *
 * The funding path persists `intendedTxHash` and `invalidHereafterSlot` on
 * the shared `Transaction` row BEFORE broadcast. On an ambiguous submit, the
 * outer batch aggregator leaves the row Pending (DOES NOT advance request
 * state to `WaitingForManualAction`, DOES NOT unlock the wallet). This
 * worker then resolves the row by querying the chain:
 *
 *   - intendedTxHash FOUND on chain → promote intendedTxHash → txHash. The
 *     existing tx-sync confirmation path then advances request state through
 *     the normal `*Initiated → *Confirmed` machinery.
 *
 *   - intendedTxHash NOT found AND `current_slot > invalidHereafterSlot + GRACE`
 *     → the ledger can never accept this txBody (TTL expired). Safe to mark
 *     the shared Transaction `RolledBack`, free the wallet, and requeue each
 *     dependent PurchaseRequest to the `*Requested` action of the sub-flow it
 *     was in (funding / set-refund / withdraw-refund / authorize-withdrawal) so
 *     the matching cron re-drives it. A fresh build will use different inputs
 *     so no double-spend is possible.
 *
 *   - intendedTxHash NOT found AND still within TTL → leave Pending. Try
 *     again next tick.
 *
 * This closes the double-lock window where the previous outer catch would
 * advance every batched request to `WaitingForManualAction` on ANY submit
 * error, allowing operator manual recovery to issue a fresh lock against
 * funds already on chain.
 */

// Wait this many slots past `invalidHereafterSlot` before declaring a tx
// provably lost. Cardano slot finality is probabilistic — a tx submitted
// near its `invalidHereafter` boundary could theoretically still land if the
// node accepts it just before the slot, the block is rolled back, and
// resubmitted… we wait through the rollback window before acting.
// At 1 slot/sec mainnet, 30 slots = 30s; we use 60 for additional safety
// against indexer lag.
const RECONCILE_SLOT_GRACE = 60;

// Cap rows per tick so a backlog doesn't starve other scheduler work.
const RECONCILE_MAX_PER_TICK = 50;

// Don't reconcile freshly created rows — the optimistic submit path needs a
// chance to write txHash first. Older than this means submit-then-record
// would have completed in steady state.
const RECONCILE_MIN_AGE_MS = 60_000;

export type ReconcileCandidate = {
	id: string;
	intendedTxHash: string;
	invalidHereafterSlot: bigint | null;
	BlocksWallet: {
		id: string;
		PaymentSource: { network: 'Mainnet' | 'Preprod'; PaymentSourceConfig: { rpcProviderApiKey: string } };
	} | null;
};

export async function reconcileAmbiguousFundingV2(): Promise<void> {
	const candidates = await prisma.transaction.findMany({
		where: {
			status: TransactionStatus.Pending,
			txHash: null,
			intendedTxHash: { not: null },
			createdAt: { lt: new Date(Date.now() - RECONCILE_MIN_AGE_MS) },
		},
		include: {
			BlocksWallet: {
				include: {
					PaymentSource: {
						include: { PaymentSourceConfig: true },
					},
				},
			},
		},
		take: RECONCILE_MAX_PER_TICK,
		orderBy: { createdAt: 'asc' },
	});

	if (candidates.length === 0) return;

	logger.info(`funding-reconciliation: ${candidates.length} ambiguous Pending row(s) to check`);

	await Promise.allSettled(
		candidates.map(async (tx) => {
			try {
				await reconcileOne(tx as ReconcileCandidate);
			} catch (error) {
				logger.error('funding-reconciliation: per-row reconcile threw', {
					txId: tx.id,
					intendedTxHash: tx.intendedTxHash,
					error: error instanceof Error ? error.message : error,
				});
			}
		}),
	);
}

/**
 * Reconcile a single ambiguous funding tx. Exposed for `wallet-timeouts` to
 * delegate to: when wallet-timeouts encounters a Pending Transaction with
 * `txHash == null && intendedTxHash != null`, it MUST NOT proceed with the
 * blind disconnect path — doing so would strand the (possibly on-chain) tx.
 * Instead it calls this function so the same probe/promote/revert state
 * machine handles both the dedicated cron and the wallet-timeouts safety net.
 *
 * Safe to call concurrently across multiple ticks: the revert path uses a
 * Serializable $transaction with an `updateMany` guard on
 * `(walletId, pendingTransactionId)`, so a duplicate revert is a no-op.
 */
export async function reconcileOne(tx: ReconcileCandidate): Promise<void> {
	// Resolve network + Blockfrost key. Preferred path is the direct
	// BlocksWallet → PaymentSource walk. If BlocksWallet was orphaned by a
	// defensive cleanup elsewhere (e.g. the invalid-state branch in
	// wallet-timeouts that force-disconnects wallets with `lockedAt: null`
	// but `PendingTransaction: not null`), fall back to ANY dependent
	// request's PaymentSource — every request shares the same source as the
	// blocking wallet did. Without this fallback the row would stay Pending
	// forever (intendedTxHash never queried), and any on-chain prep tx
	// would be operationally orphaned.
	let resolved: { network: 'Mainnet' | 'Preprod'; apiKey: string } | null = null;
	if (tx.BlocksWallet?.PaymentSource != null) {
		resolved = {
			network: tx.BlocksWallet.PaymentSource.network,
			apiKey: tx.BlocksWallet.PaymentSource.PaymentSourceConfig.rpcProviderApiKey,
		};
	} else {
		const fallbackSource = await resolvePaymentSourceForOrphanTx(tx.id);
		if (fallbackSource == null) {
			logger.warn(
				'funding-reconciliation: skipping row — no BlocksWallet and no dependent request relation to resolve PaymentSource',
				{ txId: tx.id },
			);
			return;
		}
		logger.warn('funding-reconciliation: BlocksWallet null, resolved PaymentSource via dependent request fallback', {
			txId: tx.id,
		});
		resolved = fallbackSource;
	}

	const blockfrost = getBlockfrostInstance(resolved.network, resolved.apiKey);

	// Step 1: query the chain for the intended hash.
	const chainResult = await safeFetchTx(blockfrost, tx.intendedTxHash);

	if (chainResult.status === 'found') {
		// Promote intendedTxHash → txHash. Tx-sync's confirmation pass will
		// then advance request state through the normal `*Initiated → *Confirmed`
		// machinery the next time it runs. We do NOT advance state here —
		// keeping the state machine in one place avoids duplicate code paths.
		//
		// Race guard: `updateMany` with `status: Pending, txHash: null`
		// predicate ensures promote never overwrites a row that has already
		// been concurrently advanced. Two race scenarios this defends:
		//   1. A second reconcile observer (or wallet-timeouts delegation)
		//      promoted first → second promote is a no-op (count=0).
		//   2. The revert path won the race (chain disagreed between probes,
		//      e.g. brief indexer rollback) and wrote status=RolledBack →
		//      promote refuses to clobber the terminal state. Resulting on-
		//      chain tx becomes operational orphan but no DB inconsistency
		//      between status and txHash.
		// `count == 0` is a benign race outcome, not an error — log at INFO
		// so it doesn't pollute alert pipelines.
		const promoted = await retryOnSerializationConflict(
			() =>
				prisma.transaction.updateMany({
					where: { id: tx.id, status: TransactionStatus.Pending, txHash: null },
					data: { txHash: tx.intendedTxHash, lastCheckedAt: new Date() },
				}),
			{ label: 'funding-reconciliation-promote' },
		);
		if (promoted.count === 0) {
			// Race outcome where the chain says the tx IS landed but the
			// DB row was concurrently advanced by another path (typically
			// the revert path winning a competing reconcile). DB stays
			// consistent (predicate-guarded), but the on-chain tx is now
			// an operational orphan — funds may be locked under a contract
			// whose request the DB has marked as RolledBack. Surface at
			// WARN so operators can manually reconcile via the
			// error-state-recovery endpoint or out-of-band fixup. INFO is
			// too quiet for an orphan-fund scenario.
			logger.warn(
				'funding-reconciliation: chain reports tx landed but DB row already advanced or terminal — possible on-chain orphan',
				{
					txId: tx.id,
					intendedTxHash: tx.intendedTxHash,
				},
			);
			return;
		}
		logger.info('funding-reconciliation: promoted intendedTxHash → txHash (chain found)', {
			txId: tx.id,
			intendedTxHash: tx.intendedTxHash,
		});
		return;
	}

	if (chainResult.status === 'transient-error') {
		// Indexer unhealth — leave for next tick. Don't infer "not on chain"
		// from a 5xx or fetch error; that's the original bug we're closing.
		logger.warn('funding-reconciliation: transient chain query error, retrying next tick', {
			txId: tx.id,
			intendedTxHash: tx.intendedTxHash,
			error: chainResult.error,
		});
		// Refresh lastCheckedAt so wallet-timeouts doesn't trip on this row
		// while reconciliation is still actively probing it. Wrap in
		// `retryOnSerializationConflict` for parity with the promote/revert
		// sites — tx-sync may concurrently update this row, and a silently-
		// lost bump means wallet-timeouts could re-probe the row sooner than
		// intended. Use `updateMany` with a `status: Pending` predicate so
		// we don't accidentally bump a row that's already moved to a
		// terminal state (Confirmed / RolledBack) — those rows are no
		// longer reconciliation candidates anyway.
		try {
			await retryOnSerializationConflict(
				() =>
					prisma.transaction.updateMany({
						where: { id: tx.id, status: TransactionStatus.Pending },
						data: { lastCheckedAt: new Date() },
					}),
				{ label: 'funding-reconciliation-bump-transient' },
			);
		} catch (updateError) {
			logger.warn('funding-reconciliation: failed to bump lastCheckedAt on transient', {
				txId: tx.id,
				error: updateError instanceof Error ? updateError.message : updateError,
			});
		}
		return;
	}

	// chainResult.status === 'not-found' — definitive 404 from the indexer.
	// Still need to wait past `invalidHereafterSlot + GRACE` before declaring
	// the tx provably lost: within TTL it could still propagate from another
	// node, or a transient rollback could later include it.
	const currentSlot = await safeFetchCurrentSlot(blockfrost);
	if (currentSlot == null) {
		logger.warn('funding-reconciliation: could not fetch current slot, retrying next tick', {
			txId: tx.id,
		});
		return;
	}

	if (tx.invalidHereafterSlot == null) {
		// No TTL bound recorded — extremely conservative, leave for manual
		// triage. (Shouldn't happen for rows we wrote post-fix.)
		logger.warn(
			'funding-reconciliation: chain says not-found but invalidHereafterSlot is null; leaving Pending for manual triage',
			{ txId: tx.id, intendedTxHash: tx.intendedTxHash },
		);
		return;
	}

	const ttlSlot = Number(tx.invalidHereafterSlot);
	if (currentSlot <= ttlSlot + RECONCILE_SLOT_GRACE) {
		// Still within TTL (plus grace) — the tx could yet land. Wait.
		logger.info('funding-reconciliation: not-found but still within TTL; waiting', {
			txId: tx.id,
			currentSlot,
			ttlSlot,
			grace: RECONCILE_SLOT_GRACE,
		});
		// Bump lastCheckedAt to keep wallet-timeouts out of this row.
		// Same retry + Pending-status-guard rationale as the transient-error
		// bump above.
		try {
			await retryOnSerializationConflict(
				() =>
					prisma.transaction.updateMany({
						where: { id: tx.id, status: TransactionStatus.Pending },
						data: { lastCheckedAt: new Date() },
					}),
				{ label: 'funding-reconciliation-bump-within-ttl' },
			);
		} catch (updateError) {
			logger.warn('funding-reconciliation: failed to bump lastCheckedAt on within-ttl', {
				txId: tx.id,
				error: updateError instanceof Error ? updateError.message : updateError,
			});
		}
		return;
	}

	// TTL provably elapsed. Safe to revert: the ledger will never accept this
	// txBody. Reset PurchaseRequests + free the wallet + mark RolledBack —
	// all in one Serializable transaction so nothing observes a half state.
	logger.warn('funding-reconciliation: TTL elapsed, not-found → reverting batch', {
		txId: tx.id,
		intendedTxHash: tx.intendedTxHash,
		currentSlot,
		ttlSlot,
	});

	await withSerializableSlotRetry(
		() =>
			prisma.$transaction(
				async (txdb) => {
					// Race guard: re-read the row under Serializable isolation BEFORE
					// any destructive writes. Two scenarios this defends:
					//   1. A concurrent observer (this cron's parallel iteration, or
					//      wallet-timeouts delegating to reconcileOne) promoted
					//      intendedTxHash → txHash between the outer probe and this
					//      txn body. txHash is now non-null and the tx IS on-chain.
					//      Reverting (resetting PurchaseRequests, disconnecting the
					//      wallet, marking RolledBack) would orphan the on-chain tx
					//      and trigger a double-lock when the next batch tick re-
					//      attempts.
					//   2. A concurrent revert (same race shape) already committed
					//      status=RolledBack. Repeating the revert is wasted work
					//      and would issue another PurchaseRequest reset that the
					//      first revert's state already covers.
					// Postgres SERIALIZABLE establishes the snapshot at the first
					// SELECT; concurrent writes that commit after the snapshot but
					// before our COMMIT trigger 40001 → `retryOnSerializationConflict`
					// retries → next snapshot sees the new state → bails here. So
					// Option A (re-check) suffices even without an explicit
					// updateMany predicate on the terminal write below.
					const fresh = await txdb.transaction.findUnique({
						where: { id: tx.id },
						select: { txHash: true, status: true },
					});
					if (fresh == null) {
						logger.warn('funding-reconciliation: revert race — row disappeared, skipping', {
							txId: tx.id,
						});
						return;
					}
					if (fresh.txHash != null) {
						logger.warn('funding-reconciliation: revert race — concurrent promote set txHash, abandoning revert', {
							txId: tx.id,
							observedTxHash: fresh.txHash,
							intendedTxHash: tx.intendedTxHash,
						});
						return;
					}
					if (fresh.status !== TransactionStatus.Pending) {
						logger.warn('funding-reconciliation: revert race — status no longer Pending, abandoning revert', {
							txId: tx.id,
							observedStatus: fresh.status,
						});
						return;
					}

					// Invariant: intendedTxHash is set on Transactions owned by
					// PurchaseRequest (V2 batch-payments, the refund/withdraw services,
					// and collateral-prep on their behalf) and — since MAS-392 — by
					// fund distribution. FundDistributionRequest needs no reset here:
					// its rows stay Pending for the whole in-flight window, so the
					// wallet unlock below is enough for the next distribution cycle to
					// rebuild them with fresh inputs. `reconcileReconciledRequests` in
					// the fund-distribution service observes this RolledBack row via
					// FundDistributionRequest.transactionId and releases the link.
					//
					// PaymentRequest / RegistryRequest remain unsupported: the revert
					// below only resets PurchaseRequest.currentTransactionId, so if a
					// future caller sets intendedTxHash on a Transaction referenced by
					// those, this assert fires and the orphan-FK is caught at runtime
					// instead of silently stranding rows.
					const dependentPayments = await txdb.paymentRequest.count({
						where: { currentTransactionId: tx.id },
					});
					const dependentRegistries = await txdb.registryRequest.count({
						where: { currentTransactionId: tx.id },
					});
					if (dependentPayments > 0 || dependentRegistries > 0) {
						throw new Error(
							`funding-reconciliation: invariant violated for Transaction ${tx.id} — ` +
								`intendedTxHash is currently a purchase-only flow but found ` +
								`${dependentPayments} dependent PaymentRequest(s) and ${dependentRegistries} dependent RegistryRequest(s). ` +
								`Generalize the revert to handle these request types before extending the flow.`,
						);
					}
					// Reset every PurchaseRequest whose CurrentTransaction points at this
					// row, requeuing each to the *Requested action for the sub-flow it
					// was in (funding / set-refund / withdraw-refund / authorize-
					// withdrawal) so the correct cron picks it up. A fresh build uses
					// different inputs, so no double-spend is possible.
					const dependentPurchases = await txdb.purchaseRequest.findMany({
						where: { currentTransactionId: tx.id },
						select: { id: true, nextActionId: true, NextAction: { select: { requestedAction: true } } },
					});
					for (const pr of dependentPurchases) {
						const inFlightAction = pr.NextAction?.requestedAction;
						const requeueAction =
							(inFlightAction != null ? REVERT_REQUEUE_ACTION[inFlightAction] : undefined) ??
							PurchasingAction.FundsLockingRequested;
						if (inFlightAction == null || REVERT_REQUEUE_ACTION[inFlightAction] == null) {
							logger.warn(
								'funding-reconciliation: unrecognised in-flight action on revert, defaulting to FundsLockingRequested',
								{ txId: tx.id, purchaseRequestId: pr.id, inFlightAction },
							);
						}
						await txdb.purchaseRequest.update({
							where: { id: pr.id },
							data: {
								ActionHistory: { connect: { id: pr.nextActionId } },
								NextAction: {
									create: {
										requestedAction: requeueAction,
										errorType: null,
										errorNote: null,
									},
								},
								CurrentTransaction: { disconnect: true },
							},
						});
					}
					// Disconnect wallet + free the lock.
					if (tx.BlocksWallet != null) {
						await txdb.hotWallet.updateMany({
							where: { id: tx.BlocksWallet.id, deletedAt: null, pendingTransactionId: tx.id },
							data: { pendingTransactionId: null, lockedAt: null },
						});
					}
					// Mark the row terminal.
					await txdb.transaction.update({
						where: { id: tx.id },
						data: {
							status: TransactionStatus.RolledBack,
							// Keep intendedTxHash for forensic value; clear lastCheckedAt
							// not needed (status != Pending excludes from polls).
						},
					});
				},
				{ isolationLevel: 'Serializable', timeout: 30_000, maxWait: 30_000 },
			),
		{ label: 'funding-reconciliation-revert' },
	);
}

type ChainResult = { status: 'found' } | { status: 'not-found' } | { status: 'transient-error'; error: string };

async function safeFetchTx(blockfrost: ReturnType<typeof getBlockfrostInstance>, txHash: string): Promise<ChainResult> {
	try {
		await blockfrost.txs(txHash);
		return { status: 'found' };
	} catch (error) {
		const msg = error instanceof Error ? error.message : String(error);
		if (/404|not.?found/i.test(msg)) {
			return { status: 'not-found' };
		}
		return { status: 'transient-error', error: msg };
	}
}

async function safeFetchCurrentSlot(blockfrost: ReturnType<typeof getBlockfrostInstance>): Promise<number | null> {
	try {
		const latest = await blockfrost.blocksLatest();
		const slot = latest?.slot;
		return typeof slot === 'number' ? slot : null;
	} catch (error) {
		logger.warn('funding-reconciliation: blocksLatest failed', {
			error: error instanceof Error ? error.message : error,
		});
		return null;
	}
}

/**
 * Fallback PaymentSource resolution for orphaned Transactions whose
 * BlocksWallet relation was severed (e.g. by the invalid-state cleanup in
 * wallet-timeouts that disconnects wallets where `lockedAt: null` but
 * `PendingTransaction: not null`). Every dependent request (payment,
 * purchase, registry, inbox) carries the same PaymentSource as the blocking
 * wallet did, so the first match is sufficient. Returns null if no
 * dependent request points at this tx — at that point the row is
 * unrecoverable and must be operator-cleaned.
 */
async function resolvePaymentSourceForOrphanTx(
	txId: string,
): Promise<{ network: 'Mainnet' | 'Preprod'; apiKey: string } | null> {
	// All four request models have a direct PaymentSource relation, so walk
	// straight to the source instead of through SmartContractWallet (which
	// may itself be null on PaymentRequest).
	const sourceInclude = { PaymentSource: { include: { PaymentSourceConfig: true } } } as const;

	const paymentReq = await prisma.paymentRequest.findFirst({
		where: { currentTransactionId: txId },
		select: sourceInclude,
	});
	if (paymentReq?.PaymentSource?.PaymentSourceConfig != null) {
		return {
			network: paymentReq.PaymentSource.network,
			apiKey: paymentReq.PaymentSource.PaymentSourceConfig.rpcProviderApiKey,
		};
	}

	const purchaseReq = await prisma.purchaseRequest.findFirst({
		where: { currentTransactionId: txId },
		select: sourceInclude,
	});
	if (purchaseReq?.PaymentSource?.PaymentSourceConfig != null) {
		return {
			network: purchaseReq.PaymentSource.network,
			apiKey: purchaseReq.PaymentSource.PaymentSourceConfig.rpcProviderApiKey,
		};
	}

	const registryReq = await prisma.registryRequest.findFirst({
		where: { currentTransactionId: txId },
		select: sourceInclude,
	});
	if (registryReq?.PaymentSource?.PaymentSourceConfig != null) {
		return {
			network: registryReq.PaymentSource.network,
			apiKey: registryReq.PaymentSource.PaymentSourceConfig.rpcProviderApiKey,
		};
	}

	const inboxReq = await prisma.inboxAgentRegistrationRequest.findFirst({
		where: { currentTransactionId: txId },
		select: sourceInclude,
	});
	if (inboxReq?.PaymentSource?.PaymentSourceConfig != null) {
		return {
			network: inboxReq.PaymentSource.network,
			apiKey: inboxReq.PaymentSource.PaymentSourceConfig.rpcProviderApiKey,
		};
	}

	return null;
}
