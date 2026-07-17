import {
	FundDistributionPriority,
	FundDistributionStatus,
	HotWalletType,
	LowBalanceStatus,
	Network,
	TransactionStatus,
} from '@/generated/prisma/client';
import { prisma } from '@masumi/payment-core/db';
import { CONFIG, CONSTANTS } from '@masumi/payment-core/config';
import { logger } from '@masumi/payment-core/logger';
import { Mutex } from 'async-mutex';
import { withJobLock } from '@/services/shared/job-runner';
import { lookupChainTx } from '@/services/shared/chain-tx-lookup';
import { webhookEventsService } from '@/services/webhooks';
import { getFundWalletForPaymentSource, loadFundWalletContext } from './context';
import { processRequestsForFundWallet } from './batch-executor';

const mutex = new Mutex();

export class FundDistributionService {
	isRunning(): boolean {
		return mutex.isLocked();
	}

	async requestTopup(params: {
		targetWalletId: string;
		currentBalance: bigint;
		paymentSourceId: string;
	}): Promise<void> {
		const { targetWalletId, currentBalance, paymentSourceId } = params;

		const fundWallet = await getFundWalletForPaymentSource(paymentSourceId);
		if (fundWallet == null) return;

		// Guard: fund wallet must not fund itself
		if (fundWallet.id === targetWalletId) return;

		const priority =
			currentBalance < fundWallet.config.criticalThreshold
				? FundDistributionPriority.Critical
				: FundDistributionPriority.Warning;

		// Use a serializable transaction to atomically check for an existing pending/submitted
		// request and create a new one. This prevents duplicate requests from concurrent calls
		// (e.g. scheduled cycle + low-balance alert firing simultaneously).
		let created = false;
		try {
			await prisma.$transaction(
				async (tx) => {
					const alreadyPending = await tx.fundDistributionRequest.findFirst({
						where: {
							fundWalletId: fundWallet.id,
							targetWalletId,
							status: { in: [FundDistributionStatus.Pending, FundDistributionStatus.Submitted] },
						},
						select: { id: true },
					});
					if (alreadyPending) return;

					await tx.fundDistributionRequest.create({
						data: {
							fundWalletId: fundWallet.id,
							targetWalletId,
							priority,
							amount: fundWallet.config.topupAmount,
							status: FundDistributionStatus.Pending,
						},
					});
					created = true;
				},
				{ isolationLevel: 'Serializable' },
			);
		} catch (error) {
			// P2034 = serialization conflict — a concurrent call already created the request
			if ((error as { code?: string }).code === 'P2034') {
				logger.debug('Skipping duplicate fund distribution request (serialization conflict)', {
					component: 'fund_distribution',
					target_wallet_id: targetWalletId,
				});
				return;
			}
			throw error;
		}

		if (!created) return;

		logger.info('Fund distribution request created', {
			component: 'fund_distribution',
			fund_wallet_id: fundWallet.id,
			target_wallet_id: targetWalletId,
			priority,
			amount: fundWallet.config.topupAmount.toString(),
		});

		if (priority === FundDistributionPriority.Critical) {
			// Critical requests skip the batch window and go out immediately -- but
			// only when we're not already inside a distribution cycle. `scanAndCreate
			// MissingRequests` calls requestTopup while holding this same mutex, so
			// attempting to re-acquire it always fails (tryAcquire is not reentrant)
			// and logged "already running, skipping cycle" on every critical topup.
			// The cycle's own critical phase picks this request up moments later, so
			// there is genuinely nothing to do here.
			//
			// The check is racy by nature, but benignly: losing it just means
			// withJobLock declines and the next cycle (<=30s) sends the request --
			// exactly what happened before, minus the misleading log.
			if (mutex.isLocked()) return;

			await withJobLock(mutex, 'fund_distribution_critical', async () => {
				const targetWallet = await prisma.hotWallet.findUnique({
					where: { id: targetWalletId },
					select: { walletAddress: true },
				});
				if (!targetWallet) return;

				const request = await prisma.fundDistributionRequest.findFirst({
					where: {
						fundWalletId: fundWallet.id,
						targetWalletId,
						status: FundDistributionStatus.Pending,
						priority: FundDistributionPriority.Critical,
					},
					select: { id: true, amount: true },
				});
				if (!request) return;

				await processRequestsForFundWallet(fundWallet, [
					{ id: request.id, targetWalletId, targetAddress: targetWallet.walletAddress, amount: request.amount },
				]);
			});
		}
	}

	async processDistributionCycle(): Promise<void> {
		await withJobLock(mutex, 'fund_distribution_cycle', async () => {
			// Fund distribution is opt-in: it does nothing until an operator creates
			// a Funding wallet for a payment source. Resolve the funded sources once
			// up front and bail when there are none, so the common (unconfigured)
			// deployment costs one indexed query per cycle instead of a full
			// low-balance scan plus a lookup per low wallet, every 30s, forever.
			const fundWallets = await prisma.hotWallet.findMany({
				where: {
					type: HotWalletType.Funding,
					deletedAt: null,
					FundDistributionConfig: { enabled: true },
				},
				select: { paymentSourceId: true },
			});
			if (fundWallets.length === 0) return;
			const fundedPaymentSourceIds = fundWallets.map((wallet) => wallet.paymentSourceId);

			// Phases are run independently: a throw in one must not starve the
			// others. In particular the send phases take a Serializable lock that
			// can lose to a concurrent writer (P2034), and letting that escape would
			// skip the confirm phase — so an unrelated conflict would leave settled
			// batches unconfirmed and their wallets locked.
			await this.runPhase(
				'reconcile-in-flight',
				// Runs FIRST so a promoted batch is marked Submitted (and a rolled-back
				// one released) before the scan considers those targets un-serviced.
				() => this.reconcileInFlightRequests(),
			);
			await this.runPhase('scan', () => this.scanAndCreateMissingRequests(fundedPaymentSourceIds));
			await this.runPhase('critical', () => this.processCriticalRequests());
			await this.runPhase('expired-batch', () => this.processExpiredBatchRequests());
			await this.runPhase('confirm', () => this.confirmSubmittedRequests());
		});
	}

	private async runPhase(phase: string, run: () => Promise<void>): Promise<void> {
		try {
			await run();
		} catch (error) {
			logger.error('Fund distribution phase failed; continuing with the rest of the cycle', {
				component: 'fund_distribution',
				phase,
				error: error instanceof Error ? error.message : String(error),
			});
		}
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
	private async reconcileInFlightRequests(): Promise<void> {
		const inFlight = await prisma.fundDistributionRequest.findMany({
			where: {
				status: FundDistributionStatus.Pending,
				transactionId: { not: null },
			},
			select: {
				id: true,
				batchId: true,
				transactionId: true,
				Transaction: {
					select: { txHash: true, intendedTxHash: true, status: true, createdAt: true },
				},
			},
		});

		if (inFlight.length === 0) return;

		const promotedByTxHash = new Map<string, string[]>();
		const releasedIds: string[] = [];

		// Anything older than the lock timeout that was never signed has provably
		// been abandoned; see the never-broadcast branch below.
		const abandonedBefore = new Date(Date.now() - CONFIG.WALLET_LOCK_TIMEOUT_INTERVAL);

		for (const request of inFlight) {
			const tx = request.Transaction;
			if (tx == null) continue;

			// RolledBack FIRST. tx-sync marks a Transaction RolledBack by txHash
			// while LEAVING txHash set, so checking txHash first would promote a
			// batch the chain has already discarded — correct in the end (it fails
			// 30min later and rebuilds) but 30 minutes late for no reason.
			if (tx.status === TransactionStatus.RolledBack) {
				releasedIds.push(request.id);
			} else if (tx.txHash != null) {
				const group = promotedByTxHash.get(tx.txHash) ?? [];
				group.push(request.id);
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
				releasedIds.push(request.id);
			}
			// Otherwise: signed and in flight. Leave it for reconciliation.
		}

		for (const [txHash, ids] of promotedByTxHash) {
			await prisma.fundDistributionRequest.updateMany({
				where: { id: { in: ids }, status: FundDistributionStatus.Pending },
				data: { status: FundDistributionStatus.Submitted, txHash },
			});
			logger.info('Adopted reconciliation-promoted fund distribution batch', {
				component: 'fund_distribution',
				tx_hash: txHash,
				request_count: ids.length,
			});
		}

		if (releasedIds.length > 0) {
			await prisma.fundDistributionRequest.updateMany({
				where: { id: { in: releasedIds }, status: FundDistributionStatus.Pending },
				data: { transactionId: null, batchId: null },
			});
			logger.warn('Released fund distribution requests for rebuild (rolled back or never broadcast)', {
				component: 'fund_distribution',
				request_count: releasedIds.length,
			});
		}
	}

	private async scanAndCreateMissingRequests(fundedPaymentSourceIds: string[]): Promise<void> {
		// Find wallets with Low balance rules that have no pending/submitted
		// distribution request. Scoped to payment sources that actually have an
		// enabled fund wallet: without that filter, every low wallet on an
		// unfunded source triggered a getFundWalletForPaymentSource lookup that
		// could only ever return null -- N wasted queries per wallet, per cycle.
		const lowBalanceWallets = await prisma.hotWallet.findMany({
			where: {
				deletedAt: null,
				type: { not: HotWalletType.Funding },
				paymentSourceId: { in: fundedPaymentSourceIds },
				LowBalanceRules: {
					some: {
						status: LowBalanceStatus.Low,
						enabled: true,
						assetUnit: 'lovelace',
					},
				},
				FundDistributionsReceived: {
					none: {
						status: { in: [FundDistributionStatus.Pending, FundDistributionStatus.Submitted] },
					},
				},
			},
			select: {
				id: true,
				paymentSourceId: true,
				LowBalanceRules: {
					where: { status: LowBalanceStatus.Low, enabled: true, assetUnit: 'lovelace' },
					select: { lastKnownAmount: true },
				},
			},
		});

		for (const wallet of lowBalanceWallets) {
			// Use lastKnownAmount for priority classification. If null (rule never evaluated),
			// default to 0n so the request is treated as Critical — the safe assumption
			// when we have no balance data.
			const lastKnownAmount = wallet.LowBalanceRules[0]?.lastKnownAmount ?? 0n;
			await this.requestTopup({
				targetWalletId: wallet.id,
				currentBalance: lastKnownAmount,
				paymentSourceId: wallet.paymentSourceId,
			});
		}
	}

	private async processCriticalRequests(): Promise<void> {
		const criticalRequests = await prisma.fundDistributionRequest.findMany({
			where: {
				priority: FundDistributionPriority.Critical,
				status: FundDistributionStatus.Pending,
				// Never rebuild a row that is already linked to an in-flight
				// Transaction (an ambiguous submit awaiting reconciliation). Without
				// this the fund-wallet lock is the ONLY thing preventing a second send
				// of the same top-up, and anything that frees that lock early — e.g.
				// the wallet-timeouts sweep, which shares no coordination with this
				// service — turns into a treasury double-spend. Phase A owns these
				// rows and hands them back by clearing transactionId on rollback.
				transactionId: null,
			},
			select: {
				id: true,
				fundWalletId: true,
				targetWalletId: true,
				amount: true,
				TargetWallet: { select: { walletAddress: true } },
			},
			orderBy: { createdAt: 'asc' },
		});

		if (criticalRequests.length === 0) return;

		// Group by fund wallet
		const byFundWallet = new Map<string, typeof criticalRequests>();
		for (const req of criticalRequests) {
			const group = byFundWallet.get(req.fundWalletId) ?? [];
			group.push(req);
			byFundWallet.set(req.fundWalletId, group);
		}

		for (const [fundWalletId, requests] of byFundWallet) {
			const fundWallet = await loadFundWalletContext(fundWalletId);
			if (!fundWallet) continue;

			const mappedRequests = requests.map((r) => ({
				id: r.id,
				targetWalletId: r.targetWalletId,
				targetAddress: r.TargetWallet.walletAddress,
				amount: r.amount,
			}));

			await processRequestsForFundWallet(fundWallet, mappedRequests);
		}
	}

	private async processExpiredBatchRequests(): Promise<void> {
		// Find pending warning requests grouped by fund wallet
		const warningRequests = await prisma.fundDistributionRequest.findMany({
			where: {
				priority: FundDistributionPriority.Warning,
				status: FundDistributionStatus.Pending,
				// See processCriticalRequests: rows with a live Transaction belong to
				// Phase A, not to a fresh build.
				transactionId: null,
			},
			select: {
				id: true,
				fundWalletId: true,
				targetWalletId: true,
				amount: true,
				createdAt: true,
				TargetWallet: { select: { walletAddress: true } },
				FundWallet: {
					select: {
						FundDistributionConfig: { select: { batchWindowMs: true } },
					},
				},
			},
			orderBy: { createdAt: 'asc' },
		});

		if (warningRequests.length === 0) return;

		// Group by fund wallet, check if oldest request exceeds batch window
		const byFundWallet = new Map<string, typeof warningRequests>();
		for (const req of warningRequests) {
			const group = byFundWallet.get(req.fundWalletId) ?? [];
			group.push(req);
			byFundWallet.set(req.fundWalletId, group);
		}

		const now = Date.now();
		for (const [fundWalletId, requests] of byFundWallet) {
			const batchWindowMs =
				requests[0]?.FundWallet.FundDistributionConfig?.batchWindowMs ??
				CONSTANTS.FUND_DISTRIBUTION_DEFAULT_BATCH_WINDOW_MS;
			const oldestCreatedAt = requests[0]?.createdAt.getTime() ?? now;

			if (now - oldestCreatedAt < batchWindowMs) continue;

			const fundWallet = await loadFundWalletContext(fundWalletId);
			if (!fundWallet) continue;

			await processRequestsForFundWallet(
				fundWallet,
				requests.map((r) => ({
					id: r.id,
					targetWalletId: r.targetWalletId,
					targetAddress: r.TargetWallet.walletAddress,
					amount: r.amount,
				})),
			);
		}
	}

	private async confirmSubmittedRequests(): Promise<void> {
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
			const group = byFundWallet.get(req.fundWalletId) ?? [];
			group.push(req);
			byFundWallet.set(req.fundWalletId, group);
		}

		for (const [fundWalletId, requests] of byFundWallet) {
			const rpcKey = requests[0]?.FundWallet.PaymentSource.PaymentSourceConfig?.rpcProviderApiKey;
			const network = requests[0]?.FundWallet.PaymentSource.network;
			if (!rpcKey || !network) continue;

			// Deduplicate by txHash — batched requests share one hash, so one Blockfrost call covers all
			const byTxHash = new Map<string, typeof requests>();
			for (const req of requests) {
				if (!req.txHash) continue;
				const group = byTxHash.get(req.txHash) ?? [];
				group.push(req);
				byTxHash.set(req.txHash, group);
			}

			// Transactions we drove to a terminal state in this pass, and are
			// therefore entitled to release the lock for. Tracked per transaction
			// rather than as one flag over the whole wallet: `hasUnresolved` was too
			// coarse (an unrelated in-flight batch would block a legitimate unlock)
			// and requiring exactly one transaction id was worse — it silently
			// declined to unlock at all whenever a wallet held rows from two
			// batches, leaving the lock to be cleaned up by another service.
			const resolvedTransactionIds = new Set<string>();

			for (const [txHash, txRequests] of byTxHash) {
				const transactionId = txRequests[0]?.transactionId ?? null;
				// Every request under this txHash shares one batch, so one payload
				// describes the whole outcome.
				const outcomePayload = {
					batchId: txRequests[0]?.batchId ?? '',
					fundWalletId,
					fundWalletAddress: txRequests[0]?.FundWallet.walletAddress ?? '',
					network: txRequests[0]?.FundWallet.PaymentSource.network ?? Network.Preprod,
					distributions: txRequests.map((req) => ({
						requestId: req.id,
						targetWalletId: req.targetWalletId,
						targetWalletAddress: req.TargetWallet.walletAddress,
						amount: req.amount.toString(),
					})),
				};

				// Classified on the structured HTTP status, never on error text: a
				// 404 must fail the batch and a 5xx must not, and the two are
				// indistinguishable by message (see `lookupChainTx`).
				const chainResult = await lookupChainTx({ network, rpcProviderApiKey: rpcKey, txHash });

				if (chainResult === 'found') {
					await prisma.fundDistributionRequest.updateMany({
						where: { id: { in: txRequests.map((r) => r.id) }, status: FundDistributionStatus.Submitted },
						data: { status: FundDistributionStatus.Confirmed, error: null },
					});
					await webhookEventsService.triggerFundDistributionConfirmed({ ...outcomePayload, txHash });
					if (transactionId) resolvedTransactionIds.add(transactionId);
				} else if (chainResult === 'not-found') {
					// Only mark as Failed after the confirmation timeout has elapsed.
					// Within the window the requests stay Submitted and will be retried next cycle
					// (Blockfrost indexing can lag, especially on mainnet).
					const submittedAt = txRequests[0]?.updatedAt.getTime() ?? 0;
					const timedOut = Date.now() - submittedAt > CONSTANTS.FUND_DISTRIBUTION_TX_CONFIRMATION_TIMEOUT_MS;

					if (timedOut) {
						const error = 'Transaction not found on-chain after timeout';
						await prisma.fundDistributionRequest.updateMany({
							where: { id: { in: txRequests.map((r) => r.id) }, status: FundDistributionStatus.Submitted },
							data: {
								status: FundDistributionStatus.Failed,
								error,
							},
						});
						// The batch was submitted but never landed. Without this the
						// operator's last signal was FUND_DISTRIBUTION_SENT and they
						// would believe the wallets were topped up.
						await webhookEventsService.triggerFundDistributionFailed({ ...outcomePayload, txHash, error });
						if (transactionId) resolvedTransactionIds.add(transactionId);
					} else {
						logger.debug('Fund distribution tx not yet indexed, will retry next cycle', {
							component: 'fund_distribution',
							tx_hash: txHash,
						});
					}
				} else {
					// Indexer unhealthy. Do NOT infer "not on chain" from a 5xx — that is
					// how a healthy tx gets marked Failed and re-sent. Leaving it out of
					// resolvedTransactionIds keeps its lock held.
					logger.warn('Failed to confirm fund distribution tx', {
						component: 'fund_distribution',
						tx_hash: txHash,
						request_ids: txRequests.map((r) => r.id),
					});
				}
			}

			// Release the lock only if the transaction currently HOLDING it is one we
			// just drove terminal.
			//
			// The `in` predicate does the discriminating: a transaction still in
			// flight is absent from the set, so its lock survives; a wallet holding
			// rows from two batches releases whichever one it is actually locked on
			// instead of declining to unlock at all. And matching on
			// pendingTransactionId means we can never clear a lock we do not own —
			// an unguarded clear lets the next cycle rebuild rows whose tx is still
			// in flight, which spends the treasury twice.
			if (resolvedTransactionIds.size > 0) {
				const { count } = await prisma.hotWallet.updateMany({
					where: { id: fundWalletId, deletedAt: null, pendingTransactionId: { in: [...resolvedTransactionIds] } },
					data: {
						lockedAt: null,
						pendingTransactionId: null,
					},
				});

				if (count === 0) {
					// The lock is held by a batch we did not resolve (or was already
					// freed elsewhere). Benign — leave it alone.
					logger.debug('Fund wallet lock is held by an unresolved batch; leaving it', {
						component: 'fund_distribution',
						fund_wallet_id: fundWalletId,
						resolved_transaction_ids: [...resolvedTransactionIds],
					});
				} else {
					logger.info('Fund wallet unlocked after distribution confirmation', {
						component: 'fund_distribution',
						fund_wallet_id: fundWalletId,
					});
				}
			} else {
				logger.debug('Fund wallet kept locked — no batch reached a terminal state this pass', {
					component: 'fund_distribution',
					fund_wallet_id: fundWalletId,
				});
			}
		}
	}
}

export const fundDistributionService = new FundDistributionService();
