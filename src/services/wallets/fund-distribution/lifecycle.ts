import { FundDistributionStatus, TransactionStatus } from '@/generated/prisma/client';
import { prisma } from '@masumi/payment-core/db';
import { CONFIG, CONSTANTS } from '@masumi/payment-core/config';
import { logger } from '@masumi/payment-core/logger';
import { lookupChainTx } from '@/services/shared/chain-tx-lookup';
import { webhookEventsService } from '@/services/webhooks';
import { retryOnSerializationConflict } from '@masumi/payment-core/db-retry';

// Thrown inside a Serializable transaction when a status-predicated updateMany
// matched only part of a batch. Committing the partial subset would move rows
// into a new status while skipping their lifecycle webhook — rolling the whole
// transaction back keeps the batch consistent for the next cycle's re-read.
const PARTIAL_BATCH_TRANSITION = 'PARTIAL_BATCH_TRANSITION';

function partialBatchTransitionError(): Error & { code: string } {
	return Object.assign(new Error(PARTIAL_BATCH_TRANSITION), { code: PARTIAL_BATCH_TRANSITION });
}

function isPartialBatchTransitionError(error: unknown): boolean {
	return (error as { code?: string } | null)?.code === PARTIAL_BATCH_TRANSITION;
}

/**
 * Adopt the outcome funding-reconciliation reached for a batch whose submit
 * was ambiguous.
 *
 * On an ambiguous submit we leave the requests Pending, the Transaction
 * Pending with `intendedTxHash` set, and the fund wallet locked.
 * `reconcileOne` then resolves the Transaction against the chain — but it
 * only knows about PurchaseRequests, so nothing maps its decision back onto
 * the distribution rows. Without this phase a promoted batch strands
 * forever: the requests stay Pending, `confirmSubmittedRequests` only looks
 * at Submitted, and the wallet never unlocks.
 *
 *   - Transaction RolledBack   → the ledger provably never took the body and
 *     the wallet is already free. Release the link so the rows rebuild with
 *     fresh inputs. Checked FIRST: a RolledBack row can still carry a txHash.
 *   - Transaction promoted (txHash set) → the tx IS on chain. Advance the
 *     requests to Submitted so the normal confirmation phase adopts them.
 *     Re-sending here would double-spend the float.
 *   - Never broadcast (no intendedTxHash, past the lock timeout) → a crash
 *     between creating the Transaction and signing. Nothing else recovers
 *     these; release them.
 *   - Otherwise                → signed and in flight; leave alone.
 */
export async function reconcileInFlightRequests(): Promise<void> {
	const inFlight = await prisma.fundDistributionRequest.findMany({
		where: {
			status: FundDistributionStatus.Pending,
			transactionId: { not: null },
		},
		select: {
			id: true,
			batchId: true,
			amount: true,
			assetUnit: true,
			targetWalletId: true,
			transactionId: true,
			TargetWallet: { select: { walletAddress: true, deletedAt: true } },
			FundWallet: {
				select: {
					id: true,
					walletAddress: true,
					paymentSourceId: true,
					deletedAt: true,
					PaymentSource: { select: { network: true, deletedAt: true } },
				},
			},
			Transaction: {
				select: { txHash: true, intendedTxHash: true, status: true, createdAt: true },
			},
		},
	});

	if (inFlight.length === 0) return;

	const promotedByTxHash = new Map<string, typeof inFlight>();
	const releasedIds: string[] = [];
	const cancelledIds: string[] = [];

	// Anything older than the lock timeout that was never signed has provably
	// been abandoned; see the never-broadcast branch below.
	const abandonedBefore = new Date(Date.now() - CONFIG.WALLET_LOCK_TIMEOUT_INTERVAL);

	for (const request of inFlight) {
		const tx = request.Transaction;
		if (tx == null) continue;
		const fundWallet = request.FundWallet;
		if (fundWallet == null) {
			cancelledIds.push(request.id);
			continue;
		}
		const canRetry =
			fundWallet.deletedAt == null &&
			fundWallet.PaymentSource.deletedAt == null &&
			request.TargetWallet.deletedAt == null;

		// RolledBack FIRST. tx-sync marks a Transaction RolledBack by txHash
		// while LEAVING txHash set, so checking txHash first would promote a
		// batch the chain has already discarded — correct in the end (it fails
		// 30min later and rebuilds) but 30 minutes late for no reason.
		if (tx.status === TransactionStatus.RolledBack) {
			(canRetry ? releasedIds : cancelledIds).push(request.id);
		} else if (tx.txHash != null) {
			const group = promotedByTxHash.get(tx.txHash) ?? [];
			group.push(request);
			promotedByTxHash.set(tx.txHash, group);
		} else if (tx.intendedTxHash == null && tx.createdAt < abandonedBefore) {
			// Never-broadcast orphan: the process died between creating the
			// Transaction and recording intendedTxHash, so nothing was signed and
			// nothing can be on chain. No other worker recovers this — the
			// reconciliation cron only considers rows WITH an intendedTxHash, and
			// wallet-timeouts frees the wallet without touching these rows. Left
			// here they are excluded from a rebuild by the `transactionId: null`
			// filter AND counted as "already queued" by the scan, so the target
			// wallet would never be topped up again. Release them.
			(canRetry ? releasedIds : cancelledIds).push(request.id);
		}
		// Otherwise: signed and in flight. Leave it for reconciliation.
	}

	for (const [txHash, requests] of promotedByTxHash) {
		const first = requests[0];
		if (first == null) continue;
		const fundWallet = first.FundWallet;
		if (fundWallet == null) continue;
		const ids = requests.map((request) => request.id);
		let didPromote = false;
		try {
			didPromote = await retryOnSerializationConflict(
				() =>
					prisma.$transaction(
						async (tx) => {
							const promoted = await tx.fundDistributionRequest.updateMany({
								where: { id: { in: ids }, status: FundDistributionStatus.Pending },
								data: { status: FundDistributionStatus.Submitted, txHash },
							});
							// Roll back rather than commit a partial promotion: rows moved
							// to Submitted here would skip the SENT webhook forever, since
							// the next cycle's Pending query no longer sees them.
							if (promoted.count !== ids.length) throw partialBatchTransitionError();

							await webhookEventsService.queueFundDistributionSent(
								tx,
								{
									batchId: first.batchId ?? first.transactionId ?? txHash,
									fundWalletId: fundWallet.id,
									fundWalletAddress: fundWallet.walletAddress,
									network: fundWallet.PaymentSource.network,
									txHash,
									distributions: requests.map((request) => ({
										requestId: request.id,
										targetWalletId: request.targetWalletId,
										targetWalletAddress: request.TargetWallet.walletAddress,
										assetUnit: request.assetUnit,
										amount: request.amount.toString(),
									})),
								},
								fundWallet.paymentSourceId,
							);
							return true;
						},
						{ isolationLevel: 'Serializable' },
					),
				{ label: 'fund-distribution-adopt-promoted' },
			);
		} catch (error) {
			if (!isPartialBatchTransitionError(error)) throw error;
		}
		if (!didPromote) continue;
		logger.info('Adopted reconciliation-promoted fund distribution batch', {
			component: 'fund_distribution',
			tx_hash: txHash,
			request_count: ids.length,
		});
	}

	if (cancelledIds.length > 0) {
		await prisma.fundDistributionRequest.updateMany({
			where: { id: { in: cancelledIds }, status: FundDistributionStatus.Pending },
			data: {
				status: FundDistributionStatus.Failed,
				error: 'Distribution cancelled because its payment source or wallet is inactive',
				transactionId: null,
			},
		});
	}

	if (releasedIds.length > 0) {
		await prisma.fundDistributionRequest.updateMany({
			where: { id: { in: releasedIds }, status: FundDistributionStatus.Pending },
			data: { fundWalletId: null, transactionId: null, batchId: null },
		});
		logger.warn('Released fund distribution requests for rebuild (rolled back or never broadcast)', {
			component: 'fund_distribution',
			request_count: releasedIds.length,
		});
	}
}

export async function confirmSubmittedRequests(): Promise<void> {
	// Only confirm requests submitted more than one indexing delay ago.
	// Transactions submitted in the current cycle will not be indexed by Blockfrost yet —
	// confirming them immediately would incorrectly mark them as Failed.
	const confirmableAfter = new Date(Date.now() - CONSTANTS.FUND_DISTRIBUTION_CONFIRMATION_DELAY_MS);

	const submittedRequests = await prisma.fundDistributionRequest.findMany({
		where: {
			status: FundDistributionStatus.Submitted,
			txHash: { not: null },
			updatedAt: { lt: confirmableAfter },
		},
		select: {
			id: true,
			txHash: true,
			updatedAt: true,
			fundWalletId: true,
			batchId: true,
			amount: true,
			assetUnit: true,
			targetWalletId: true,
			// The Transaction this batch owns. The unlock below is guarded on it
			// so we can only ever release OUR OWN lock, never a newer batch's.
			transactionId: true,
			TargetWallet: { select: { walletAddress: true } },
			FundWallet: {
				select: {
					id: true,
					walletAddress: true,
					lockedAt: true,
					pendingTransactionId: true,
					PaymentSource: {
						select: {
							id: true,
							PaymentSourceConfig: { select: { rpcProviderApiKey: true } },
							network: true,
						},
					},
				},
			},
		},
	});

	// Group by fund wallet so we only unlock once per wallet after all its submitted requests are processed
	const byFundWallet = new Map<string, typeof submittedRequests>();
	for (const req of submittedRequests) {
		if (req.fundWalletId == null || req.FundWallet == null) continue;
		const group = byFundWallet.get(req.fundWalletId) ?? [];
		group.push(req);
		byFundWallet.set(req.fundWalletId, group);
	}

	for (const [fundWalletId, requests] of byFundWallet) {
		const fundWallet = requests[0]?.FundWallet;
		const rpcKey = fundWallet?.PaymentSource.PaymentSourceConfig?.rpcProviderApiKey;
		const network = fundWallet?.PaymentSource.network;
		if (!rpcKey || !network) continue;

		// Deduplicate by txHash — batched requests share one hash, so one Blockfrost call covers all
		const byTxHash = new Map<string, typeof requests>();
		for (const req of requests) {
			if (!req.txHash) continue;
			const group = byTxHash.get(req.txHash) ?? [];
			group.push(req);
			byTxHash.set(req.txHash, group);
		}

		for (const [txHash, txRequests] of byTxHash) {
			const transactionIds = [
				...new Set(
					txRequests
						.map((request) => request.transactionId)
						.filter((transactionId): transactionId is string => transactionId != null),
				),
			];
			const requestIds = txRequests.map((request) => request.id);
			const paymentSourceId = fundWallet.PaymentSource.id;
			// Every request under this txHash shares one batch, so one payload
			// describes the whole outcome.
			const outcomePayload = {
				// Consumers correlate SENT -> CONFIRMED/FAILED by batchId, so fall
				// back to a stable identifier rather than an empty string.
				batchId: txRequests[0]?.batchId ?? txRequests[0]?.transactionId ?? txHash,
				fundWalletId,
				fundWalletAddress: fundWallet.walletAddress,
				network: fundWallet.PaymentSource.network,
				distributions: txRequests.map((req) => ({
					requestId: req.id,
					targetWalletId: req.targetWalletId,
					targetWalletAddress: req.TargetWallet.walletAddress,
					assetUnit: req.assetUnit,
					amount: req.amount.toString(),
				})),
			};

			// Classified on the structured HTTP status, never on error text: a
			// 404 must fail the batch and a 5xx must not, and the two are
			// indistinguishable by message (see `lookupChainTx`).
			const chainResult = await lookupChainTx({ network, rpcProviderApiKey: rpcKey, txHash });
			const transitionBatch = async (params: {
				requestStatus: FundDistributionStatus;
				transactionStatus: TransactionStatus;
				error: string | null;
			}): Promise<boolean> => {
				try {
					return await retryOnSerializationConflict(
						() =>
							prisma.$transaction(
								async (tx) => {
									// This status predicate is the cross-replica claim. Only one
									// worker can move every row out of Submitted, so only that
									// worker emits the terminal webhook.
									const transitioned = await tx.fundDistributionRequest.updateMany({
										where: { id: { in: requestIds }, status: FundDistributionStatus.Submitted },
										data: { status: params.requestStatus, error: params.error },
									});
									// Roll back rather than commit a partial claim: rows moved
									// out of Submitted here would skip the terminal webhook,
									// and the winner's own updateMany no longer sees them.
									if (transitioned.count !== requestIds.length) throw partialBatchTransitionError();

									if (transactionIds.length > 0) {
										await tx.transaction.updateMany({
											where: { id: { in: transactionIds }, status: TransactionStatus.Pending },
											data: { status: params.transactionStatus, lastCheckedAt: new Date() },
										});
										await tx.hotWallet.updateMany({
											where: { id: fundWalletId, pendingTransactionId: { in: transactionIds } },
											data: { lockedAt: null, pendingTransactionId: null },
										});
									}

									if (paymentSourceId) {
										if (params.requestStatus === FundDistributionStatus.Confirmed) {
											await webhookEventsService.queueFundDistributionConfirmed(
												tx,
												{ ...outcomePayload, txHash },
												paymentSourceId,
											);
										} else {
											await webhookEventsService.queueFundDistributionFailed(
												tx,
												{
													...outcomePayload,
													txHash,
													error: params.error ?? 'Fund distribution failed',
												},
												paymentSourceId,
											);
										}
									}

									return true;
								},
								{ isolationLevel: 'Serializable' },
							),
						{ label: 'fund-distribution-terminal-transition' },
					);
				} catch (error) {
					if (isPartialBatchTransitionError(error)) return false;
					throw error;
				}
			};

			if (chainResult === 'found') {
				await transitionBatch({
					requestStatus: FundDistributionStatus.Confirmed,
					transactionStatus: TransactionStatus.Confirmed,
					error: null,
				});
			} else if (chainResult === 'not-found') {
				// Only mark as Failed after the confirmation timeout has elapsed.
				// Within the window the requests stay Submitted and will be retried next cycle
				// (Blockfrost indexing can lag, especially on mainnet).
				const submittedAt = txRequests[0]?.updatedAt.getTime() ?? 0;
				const timedOut = Date.now() - submittedAt > CONSTANTS.FUND_DISTRIBUTION_TX_CONFIRMATION_TIMEOUT_MS;

				if (timedOut) {
					const error = 'Transaction not found on-chain after timeout';
					await transitionBatch({
						requestStatus: FundDistributionStatus.Failed,
						transactionStatus: TransactionStatus.FailedViaTimeout,
						error,
					});
				} else {
					logger.debug('Fund distribution tx not yet indexed, will retry next cycle', {
						component: 'fund_distribution',
						tx_hash: txHash,
					});
				}
			} else {
				// Indexer unhealthy. Do NOT infer "not on chain" from a 5xx — that is
				// how a healthy tx gets marked Failed and re-sent. Leaving it
				// Submitted keeps its lock held.
				logger.warn('Failed to confirm fund distribution tx', {
					component: 'fund_distribution',
					tx_hash: txHash,
					request_ids: txRequests.map((r) => r.id),
				});
			}
		}
	}
}
