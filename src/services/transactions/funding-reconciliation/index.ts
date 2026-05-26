import { PurchasingAction, TransactionStatus } from '@/generated/prisma/client';
import { prisma } from '@masumi/payment-core/db';
import { logger } from '@masumi/payment-core/logger';
import { getBlockfrostInstance } from '@/utils/blockfrost';
import { retryOnSerializationConflict } from '@/utils/db/retry';
import { withSerializableSlot } from '@/utils/db/serializable-semaphore';

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
 *     the shared Transaction `RolledBack`, free the wallet, and reset the
 *     batched PurchaseRequests back to `FundsLockingRequested` so the next
 *     batch tick can re-lock them. A fresh build will use different inputs
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
	if (tx.BlocksWallet?.PaymentSource == null) {
		// The Transaction has no associated wallet relation we can use to
		// derive a Blockfrost API key. This row predates the
		// intendedTxHash convention and has no reconciliation context —
		// skip. (Should not happen for rows we created post-#2 fix.)
		logger.warn('funding-reconciliation: skipping row without BlocksWallet relation', { txId: tx.id });
		return;
	}

	const network = tx.BlocksWallet.PaymentSource.network;
	const apiKey = tx.BlocksWallet.PaymentSource.PaymentSourceConfig.rpcProviderApiKey;
	const blockfrost = getBlockfrostInstance(network, apiKey);

	// Step 1: query the chain for the intended hash.
	const chainResult = await safeFetchTx(blockfrost, tx.intendedTxHash);

	if (chainResult.status === 'found') {
		// Promote intendedTxHash → txHash. Tx-sync's confirmation pass will
		// then advance request state through the normal `*Initiated → *Confirmed`
		// machinery the next time it runs. We do NOT advance state here —
		// keeping the state machine in one place avoids duplicate code paths.
		logger.info('funding-reconciliation: promoted intendedTxHash → txHash (chain found)', {
			txId: tx.id,
			intendedTxHash: tx.intendedTxHash,
		});
		await retryOnSerializationConflict(
			() =>
				prisma.transaction.update({
					where: { id: tx.id },
					data: { txHash: tx.intendedTxHash, lastCheckedAt: new Date() },
				}),
			{ label: 'funding-reconciliation-promote' },
		);
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
		// while reconciliation is still actively probing it.
		try {
			await prisma.transaction.update({
				where: { id: tx.id },
				data: { lastCheckedAt: new Date() },
			});
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
		try {
			await prisma.transaction.update({
				where: { id: tx.id },
				data: { lastCheckedAt: new Date() },
			});
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

	await withSerializableSlot(() =>
		retryOnSerializationConflict(
			() =>
				prisma.$transaction(
					async (txdb) => {
						// Invariant: intendedTxHash is only set on Transactions owned by
						// PurchaseRequest (V2 collateral-prep + batch-payments). The revert
						// path below only resets PurchaseRequest.currentTransactionId. If a
						// future caller ever sets intendedTxHash on a Transaction also
						// referenced by PaymentRequest or RegistryRequest, this assert fires
						// so the orphan-FK is caught at runtime instead of silently
						// stranding rows. To extend the flow, generalize the revert below
						// to disconnect all three request types.
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
						// Reset every PurchaseRequest whose CurrentTransaction points at this row.
						const dependentPurchases = await txdb.purchaseRequest.findMany({
							where: { currentTransactionId: tx.id },
							select: { id: true, nextActionId: true },
						});
						for (const pr of dependentPurchases) {
							await txdb.purchaseRequest.update({
								where: { id: pr.id },
								data: {
									ActionHistory: { connect: { id: pr.nextActionId } },
									NextAction: {
										create: {
											requestedAction: PurchasingAction.FundsLockingRequested,
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
		),
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
