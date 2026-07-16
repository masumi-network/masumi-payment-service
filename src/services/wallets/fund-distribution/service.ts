import {
	FundDistributionPriority,
	FundDistributionStatus,
	HotWalletType,
	LowBalanceStatus,
	Network,
	TransactionStatus,
} from '@/generated/prisma/client';
import { prisma } from '@masumi/payment-core/db';
import { CONSTANTS } from '@masumi/payment-core/config';
import { logger } from '@masumi/payment-core/logger';
import { interpretBlockchainError } from '@masumi/payment-core/blockchain-error-interpreter';
import { Mutex } from 'async-mutex';
import { withJobLock } from '@/services/shared/job-runner';
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
			// Phase A: Adopt outcomes that funding-reconciliation decided for
			// ambiguously-submitted batches. Runs FIRST so a promoted batch is
			// marked Submitted (and a rolled-back one released) before the
			// scan below considers those targets un-serviced.
			await this.reconcileInFlightRequests();

			// Phase B: Scan for Low-status wallets with no pending/submitted distribution request
			await this.scanAndCreateMissingRequests();

			// Phase C: Process critical pending requests immediately
			await this.processCriticalRequests();

			// Phase D: Process warning requests whose batch window has expired
			await this.processExpiredBatchRequests();

			// Phase E: Confirm submitted transactions
			await this.confirmSubmittedRequests();
		});
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
	 *   - Transaction promoted (txHash set)  → the tx IS on chain. Advance the
	 *     requests to Submitted so the normal confirmation phase adopts them.
	 *     Re-sending here would double-spend the float.
	 *   - Transaction RolledBack             → the ledger provably never took
	 *     the body (TTL elapsed) and reconcileOne already freed the wallet.
	 *     Release the link and leave the requests Pending for a fresh build
	 *     with different inputs.
	 *   - Otherwise                          → still in flight; leave alone.
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
				Transaction: { select: { txHash: true, status: true } },
			},
		});

		if (inFlight.length === 0) return;

		const promotedByTxHash = new Map<string, string[]>();
		const rolledBackIds: string[] = [];

		for (const request of inFlight) {
			const tx = request.Transaction;
			if (tx == null) continue;

			if (tx.txHash != null) {
				const group = promotedByTxHash.get(tx.txHash) ?? [];
				group.push(request.id);
				promotedByTxHash.set(tx.txHash, group);
			} else if (tx.status === TransactionStatus.RolledBack) {
				rolledBackIds.push(request.id);
			}
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

		if (rolledBackIds.length > 0) {
			await prisma.fundDistributionRequest.updateMany({
				where: { id: { in: rolledBackIds }, status: FundDistributionStatus.Pending },
				data: { transactionId: null, batchId: null },
			});
			logger.warn('Released fund distribution requests after reconciliation rollback; will rebuild', {
				component: 'fund_distribution',
				request_count: rolledBackIds.length,
			});
		}
	}

	private async scanAndCreateMissingRequests(): Promise<void> {
		// Find all wallets with Low balance rules that have no pending/submitted distribution request
		const lowBalanceWallets = await prisma.hotWallet.findMany({
			where: {
				deletedAt: null,
				type: { not: HotWalletType.Funding },
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
		// Only confirm requests submitted more than 5 minutes ago.
		// Transactions submitted in the current cycle will not be indexed by Blockfrost yet —
		// confirming them immediately would incorrectly mark them as Failed.
		const confirmableAfter = new Date(Date.now() - 300_000);

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
			if (!rpcKey) continue;

			const { createMeshProvider } = await import('@/services/shared/provider-factory');
			const provider = await createMeshProvider(rpcKey);

			// Deduplicate by txHash — batched requests share one hash, so one Blockfrost call covers all
			const byTxHash = new Map<string, typeof requests>();
			for (const req of requests) {
				if (!req.txHash) continue;
				const group = byTxHash.get(req.txHash) ?? [];
				group.push(req);
				byTxHash.set(req.txHash, group);
			}

			// Track whether any tx is still pending indexing — if so, keep the wallet locked
			let hasUnresolved = false;

			for (const [txHash, txRequests] of byTxHash) {
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

				try {
					const txInfo = await provider.fetchTxInfo(txHash);

					if (txInfo) {
						await prisma.fundDistributionRequest.updateMany({
							where: { id: { in: txRequests.map((r) => r.id) } },
							data: { status: FundDistributionStatus.Confirmed, error: null },
						});
						await webhookEventsService.triggerFundDistributionConfirmed({ ...outcomePayload, txHash });
					} else {
						// Only mark as Failed after the confirmation timeout has elapsed.
						// Within the window the requests stay Submitted and will be retried next cycle
						// (Blockfrost indexing can lag, especially on mainnet).
						const submittedAt = txRequests[0]?.updatedAt.getTime() ?? 0;
						const timedOut = Date.now() - submittedAt > CONSTANTS.FUND_DISTRIBUTION_TX_CONFIRMATION_TIMEOUT_MS;

						if (timedOut) {
							const error = 'Transaction not found on-chain after timeout';
							await prisma.fundDistributionRequest.updateMany({
								where: { id: { in: txRequests.map((r) => r.id) } },
								data: {
									status: FundDistributionStatus.Failed,
									error,
								},
							});
							// The batch was submitted but never landed. Without this the
							// operator's last signal was FUND_DISTRIBUTION_SENT and they
							// would believe the wallets were topped up.
							await webhookEventsService.triggerFundDistributionFailed({ ...outcomePayload, txHash, error });
						} else {
							logger.debug('Fund distribution tx not yet indexed, will retry next cycle', {
								component: 'fund_distribution',
								tx_hash: txHash,
							});
							hasUnresolved = true;
						}
					}
				} catch (error) {
					logger.warn('Failed to confirm fund distribution tx', {
						component: 'fund_distribution',
						tx_hash: txHash,
						request_ids: txRequests.map((r) => r.id),
						error: interpretBlockchainError(error),
					});
					hasUnresolved = true;
				}
			}

			// Only unlock the fund wallet when all submitted txes have reached a terminal state.
			// If any tx is still pending indexing, keep the lock to prevent duplicate distributions.
			if (!hasUnresolved) {
				await prisma.hotWallet.update({
					where: { id: fundWalletId },
					data: {
						lockedAt: null,
						PendingTransaction: { disconnect: true },
					},
				});

				logger.info('Fund wallet unlocked after distribution confirmation', {
					component: 'fund_distribution',
					fund_wallet_id: fundWalletId,
				});
			} else {
				logger.debug('Fund wallet kept locked — unresolved txes still pending confirmation', {
					component: 'fund_distribution',
					fund_wallet_id: fundWalletId,
				});
			}
		}
	}
}

export const fundDistributionService = new FundDistributionService();
