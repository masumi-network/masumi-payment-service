import {
	FundDistributionPriority,
	FundDistributionStatus,
	HotWalletType,
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
import { retryOnSerializationConflict } from '@masumi/payment-core/db-retry';

const mutex = new Mutex();

export class FundDistributionService {
	isRunning(): boolean {
		return mutex.isLocked();
	}

	async requestTopup(params: {
		targetWalletId: string;
		currentBalance: bigint;
		paymentSourceId: string;
		/** Which asset is short. Defaults to ADA for callers that predate tokens. */
		assetUnit?: string;
	}): Promise<void> {
		const { targetWalletId, currentBalance, paymentSourceId, assetUnit = 'lovelace' } = params;

		const fundWallet = await getFundWalletForPaymentSource(paymentSourceId);
		if (fundWallet == null) return;

		// Guard: fund wallet must not fund itself
		if (fundWallet.id === targetWalletId) return;

		// Thresholds are per asset: 20 USDM and 20 ADA are unrelated quantities,
		// so a shortage can only be judged against its own asset's policy. No
		// policy for this asset means the operator has not asked us to top it up.
		const policy = fundWallet.config.assets.get(assetUnit);
		if (policy == null) return;
		if (currentBalance >= policy.warningThreshold) return;

		const priority =
			currentBalance < policy.criticalThreshold ? FundDistributionPriority.Critical : FundDistributionPriority.Warning;

		// Use a serializable transaction to atomically check for an existing pending/submitted
		// request and create a new one. This prevents duplicate requests from concurrent calls
		// (e.g. scheduled cycle + low-balance alert firing simultaneously).
		let created = false;
		try {
			await prisma.$transaction(
				async (tx) => {
					// The context above is intentionally loaded before opening the
					// transaction, but the source/config/target can be retired while
					// balance monitoring is in flight. Re-read lifecycle state here so
					// an obsolete scan cannot create a new Pending request afterward.
					const activeFundWallet = await tx.hotWallet.findFirst({
						where: {
							id: fundWallet.id,
							paymentSourceId,
							type: HotWalletType.Funding,
							deletedAt: null,
							PaymentSource: { deletedAt: null },
							FundDistributionConfig: { enabled: true },
						},
						select: { id: true },
					});
					if (activeFundWallet == null) return;

					const activeTargetWallet = await tx.hotWallet.findFirst({
						where: {
							id: targetWalletId,
							paymentSourceId,
							type: { not: HotWalletType.Funding },
							deletedAt: null,
							PaymentSource: { deletedAt: null },
						},
						select: { id: true },
					});
					if (activeTargetWallet == null) return;

					const failureCooldownStart = new Date(Date.now() - CONSTANTS.FUND_DISTRIBUTION_FAILURE_RETRY_COOLDOWN_MS);
					const alreadyHandled = await tx.fundDistributionRequest.findFirst({
						where: {
							fundWalletId: fundWallet.id,
							targetWalletId,
							// Scoped to the asset: an in-flight ADA top-up says nothing about
							// a USDM shortage on the same wallet, and suppressing one because
							// of the other would leave the wallet short indefinitely.
							assetUnit,
							OR: [
								{ status: { in: [FundDistributionStatus.Pending, FundDistributionStatus.Submitted] } },
								// A recent failure blocks re-creation for the cooldown. Retrying
								// is correct — the target is still low — but without this a
								// persistent build/sign error re-created the request and re-fired
								// FUND_DISTRIBUTION_FAILED every 30s cycle.
								{ status: FundDistributionStatus.Failed, updatedAt: { gt: failureCooldownStart } },
							],
						},
						select: { id: true },
					});
					if (alreadyHandled) return;

					await tx.fundDistributionRequest.create({
						data: {
							fundWalletId: fundWallet.id,
							targetWalletId,
							priority,
							assetUnit,
							amount: policy.topupAmount,
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
			asset_unit: assetUnit,
			amount: policy.topupAmount.toString(),
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
						assetUnit,
						status: FundDistributionStatus.Pending,
						priority: FundDistributionPriority.Critical,
					},
					select: { id: true, amount: true, assetUnit: true },
				});
				if (!request) return;

				await processRequestsForFundWallet(fundWallet, [
					{
						id: request.id,
						targetWalletId,
						targetAddress: targetWallet.walletAddress,
						assetUnit: request.assetUnit,
						amount: request.amount,
					},
				]);
			});
		}
	}

	async processDistributionCycle(): Promise<void> {
		await withJobLock(mutex, 'fund_distribution_cycle', async () => {
			// Reconciliation is unconditional. A disabled/deleted fund wallet may
			// still own a transaction that was broadcast before it was disabled.
			await this.runPhase('reconcile-in-flight', () => this.reconcileInFlightRequests());

			// Fund distribution is opt-in: it does nothing until an operator creates
			// a Funding wallet for a payment source. Resolve the funded sources once
			// up front and bail when there are none, so the common (unconfigured)
			// deployment costs one indexed query per cycle instead of a full
			// low-balance scan plus a lookup per low wallet, every 30s, forever.
			const fundWallets = await prisma.hotWallet.findMany({
				where: {
					type: HotWalletType.Funding,
					deletedAt: null,
					PaymentSource: { deletedAt: null },
					FundDistributionConfig: { enabled: true },
				},
				select: { paymentSourceId: true },
			});
			if (fundWallets.length > 0) {
				const fundedPaymentSourceIds = fundWallets.map((wallet) => wallet.paymentSourceId);

				// Send phases are independent so a conflict in one cannot starve the rest.
				await this.runPhase('scan', () => this.scanAndCreateMissingRequests(fundedPaymentSourceIds));
				await this.runPhase('critical', () => this.processCriticalRequests());
				await this.runPhase('expired-batch', () => this.processExpiredBatchRequests());
			}

			// Confirmation stays after scanning. Otherwise a just-confirmed request
			// disappears from the scan's exclusion set before balance monitoring has
			// observed the top-up, and stale low-balance data can queue it again.
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
				amount: true,
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
			const canRetry =
				request.FundWallet.deletedAt == null &&
				request.FundWallet.PaymentSource.deletedAt == null &&
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
			const ids = requests.map((request) => request.id);
			const didPromote = await retryOnSerializationConflict(
				() =>
					prisma.$transaction(
						async (tx) => {
							const promoted = await tx.fundDistributionRequest.updateMany({
								where: { id: { in: ids }, status: FundDistributionStatus.Pending },
								data: { status: FundDistributionStatus.Submitted, txHash },
							});
							if (promoted.count !== ids.length) return false;

							await webhookEventsService.queueFundDistributionSent(
								tx,
								{
									batchId: first.batchId ?? first.transactionId ?? txHash,
									fundWalletId: first.FundWallet.id,
									fundWalletAddress: first.FundWallet.walletAddress,
									network: first.FundWallet.PaymentSource.network,
									txHash,
									distributions: requests.map((request) => ({
										requestId: request.id,
										targetWalletId: request.targetWalletId,
										targetWalletAddress: request.TargetWallet.walletAddress,
										amount: request.amount.toString(),
									})),
								},
								first.FundWallet.paymentSourceId,
							);
							return true;
						},
						{ isolationLevel: 'Serializable' },
					),
				{ label: 'fund-distribution-adopt-promoted' },
			);
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
				data: { transactionId: null, batchId: null },
			});
			logger.warn('Released fund distribution requests for rebuild (rolled back or never broadcast)', {
				component: 'fund_distribution',
				request_count: releasedIds.length,
			});
		}
	}

	private async scanAndCreateMissingRequests(fundedPaymentSourceIds: string[]): Promise<void> {
		// Every monitored asset on every monitored wallet, not just lovelace.
		// Low-balance rules are keyed per asset, so an operator can already watch
		// USDM or USDCX; scanning only 'lovelace' meant those alerts fired into a
		// top-up path that ignored them.
		//
		// Scoped to payment sources that actually have an enabled fund wallet:
		// without that filter, every low wallet on an unfunded source triggered a
		// getFundWalletForPaymentSource lookup that could only ever return null.
		//
		// Deliberately NOT filtered on `FundDistributionsReceived: { none: ... }`.
		// That predicate is asset-blind: an in-flight ADA top-up would hide a USDM
		// shortage on the same wallet. Dedupe belongs in requestTopup, which scopes
		// it to (target, asset) inside its Serializable transaction.
		const monitoredWallets = await prisma.hotWallet.findMany({
			where: {
				deletedAt: null,
				type: { not: HotWalletType.Funding },
				paymentSourceId: { in: fundedPaymentSourceIds },
				PaymentSource: { deletedAt: null },
				LowBalanceRules: {
					some: {
						enabled: true,
						lastKnownAmount: { not: null },
					},
				},
			},
			select: {
				id: true,
				paymentSourceId: true,
				LowBalanceRules: {
					where: { enabled: true, lastKnownAmount: { not: null } },
					select: { assetUnit: true, lastKnownAmount: true },
				},
			},
		});

		for (const wallet of monitoredWallets) {
			for (const rule of wallet.LowBalanceRules) {
				if (rule.lastKnownAmount == null) continue;
				// requestTopup decides: it returns early unless this asset has a
				// configured policy and the balance is under its warning threshold.
				await this.requestTopup({
					targetWalletId: wallet.id,
					currentBalance: rule.lastKnownAmount,
					paymentSourceId: wallet.paymentSourceId,
					assetUnit: rule.assetUnit,
				});
			}
		}
	}

	private async processCriticalRequests(): Promise<void> {
		const criticalRequests = await prisma.fundDistributionRequest.findMany({
			where: {
				priority: FundDistributionPriority.Critical,
				status: FundDistributionStatus.Pending,
				TargetWallet: { deletedAt: null, PaymentSource: { deletedAt: null } },
				FundWallet: {
					deletedAt: null,
					PaymentSource: { deletedAt: null },
					FundDistributionConfig: { enabled: true },
				},
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
				assetUnit: true,
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
				assetUnit: r.assetUnit,
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
				TargetWallet: { deletedAt: null, PaymentSource: { deletedAt: null } },
				FundWallet: {
					deletedAt: null,
					PaymentSource: { deletedAt: null },
					FundDistributionConfig: { enabled: true },
				},
				// See processCriticalRequests: rows with a live Transaction belong to
				// Phase A, not to a fresh build.
				transactionId: null,
			},
			select: {
				id: true,
				fundWalletId: true,
				targetWalletId: true,
				assetUnit: true,
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
					assetUnit: r.assetUnit,
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

			for (const [txHash, txRequests] of byTxHash) {
				const transactionIds = [
					...new Set(
						txRequests
							.map((request) => request.transactionId)
							.filter((transactionId): transactionId is string => transactionId != null),
					),
				];
				const requestIds = txRequests.map((request) => request.id);
				const paymentSourceId = txRequests[0]?.FundWallet.PaymentSource.id;
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
				const transitionBatch = async (params: {
					requestStatus: FundDistributionStatus;
					transactionStatus: TransactionStatus;
					error: string | null;
				}): Promise<boolean> =>
					retryOnSerializationConflict(
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
									if (transitioned.count !== requestIds.length) return false;

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
}

export const fundDistributionService = new FundDistributionService();
