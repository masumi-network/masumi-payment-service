import {
	FundDistributionPriority,
	FundDistributionStatus,
	HotWalletType,
	TransactionStatus,
} from '@/generated/prisma/client';
import { prisma } from '@masumi/payment-core/db';
import { CONFIG, CONSTANTS } from '@masumi/payment-core/config';
import { logger } from '@masumi/payment-core/logger';
import { Mutex } from 'async-mutex';
import { withJobLock } from '@/services/shared/job-runner';
import { lookupChainTx } from '@/services/shared/chain-tx-lookup';
import { webhookEventsService } from '@/services/webhooks';
import { getFundWalletsForPaymentSource, type FundWalletContext } from './context';
import { processRequestsForFundWallet } from './batch-executor';
import { retryOnSerializationConflict } from '@masumi/payment-core/db-retry';

const mutex = new Mutex();
const DISPATCHABLE_PRIORITIES = [FundDistributionPriority.Warning, FundDistributionPriority.Critical];

class FundDistributionService {
	isRunning(): boolean {
		return mutex.isLocked();
	}

	async requestTopup(params: {
		ruleId: string;
		targetWalletId: string;
		currentBalance: bigint;
		paymentSourceId: string;
		/** Which asset is short. Defaults to ADA for callers that predate tokens. */
		assetUnit?: string;
		/** The rule's trigger: top up only when currentBalance is below this. */
		thresholdAmount: bigint;
		/** The rule's amount: how much of `assetUnit` to send, in its smallest unit. */
		topupAmount: bigint;
		/**
		 * When currentBalance was observed. A confirmed request newer than this
		 * observation already handled the shortage and suppresses another send
		 * until monitoring records a fresh balance.
		 */
		balanceCheckedAt?: Date;
	}): Promise<void> {
		const {
			ruleId,
			targetWalletId,
			currentBalance,
			paymentSourceId,
			assetUnit = 'lovelace',
			thresholdAmount,
			topupAmount,
			balanceCheckedAt,
		} = params;

		// The trigger and amount come from the hot wallet's own low-balance rule.
		// Nothing to do unless the balance is actually below the rule's threshold.
		if (currentBalance >= thresholdAmount) return;

		// A source may have several fund wallets (redundancy): any of them can fund
		// this shortage, and the request is left unassigned until dispatch picks
		// the first with funds. Without at least one, the request could never be
		// fulfilled, so there is no point recording it.
		const fundWallets = await getFundWalletsForPaymentSource(paymentSourceId);
		if (fundWallets.length === 0) return;

		// Guard: a fund wallet on this source must never be topped up as a target.
		if (fundWallets.some((wallet) => wallet.id === targetWalletId)) return;

		// Single-tier: every top-up is batched into the source's window. The
		// priority column is retained (Warning) so the dispatch phase and its
		// double-spend guards are unchanged.
		const priority = FundDistributionPriority.Warning;

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
					// Any enabled fund wallet on the source can fulfil this, so we only
					// require that at least one still exists.
					const activeFundWallet = await tx.hotWallet.findFirst({
						where: {
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

					// The scan that called us may have raced an operator changing or
					// deleting this rule. Revalidate the exact observed configuration
					// inside the same Serializable transaction that creates the request.
					// If the scan commits first, the rule mutation retires this row; if
					// the mutation commits first, this predicate no longer matches.
					const activeRule = await tx.hotWalletLowBalanceRule.findFirst({
						where: {
							id: ruleId,
							hotWalletId: targetWalletId,
							assetUnit,
							enabled: true,
							topupEnabled: true,
							thresholdAmount,
							topupAmount,
							...(balanceCheckedAt
								? {
										lastCheckedAt: balanceCheckedAt,
										lastKnownAmount: currentBalance,
									}
								: {}),
						},
						select: { id: true },
					});
					if (activeRule == null) return;

					const failureCooldownStart = new Date(Date.now() - CONSTANTS.FUND_DISTRIBUTION_FAILURE_RETRY_COOLDOWN_MS);
					const alreadyHandled = await tx.fundDistributionRequest.findFirst({
						where: {
							// Dedupe per (target, asset) across ALL fund wallets on the
							// source: a shortage is funded by exactly one wallet regardless
							// of which claims it, so an in-flight request from any wallet
							// suppresses a duplicate.
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
								...(balanceCheckedAt
									? [
											{
												status: FundDistributionStatus.Confirmed,
												updatedAt: { gte: balanceCheckedAt },
											},
										]
									: []),
							],
						},
						select: { id: true },
					});
					if (alreadyHandled) return;

					await tx.fundDistributionRequest.create({
						data: {
							// Unassigned: dispatch picks the fund wallet (first with funds).
							fundWalletId: null,
							targetWalletId,
							priority,
							assetUnit,
							amount: topupAmount,
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
			payment_source_id: paymentSourceId,
			target_wallet_id: targetWalletId,
			asset_unit: assetUnit,
			amount: topupAmount.toString(),
		});
	}

	/**
	 * Load unassigned Pending requests for a source, including legacy Critical
	 * rows, mapped to the batch-executor's shape. Unassigned = no fund wallet has
	 * claimed it yet (`fundWalletId` and `transactionId` both null); a row with a
	 * live Transaction belongs to reconciliation, not a fresh build.
	 */
	private async loadUnassignedRequests(
		paymentSourceId: string,
	): Promise<Array<{ id: string; targetWalletId: string; targetAddress: string; assetUnit: string; amount: bigint }>> {
		const requests = await prisma.fundDistributionRequest.findMany({
			where: {
				// Critical is retained for upgrade compatibility. New requests are
				// Warning, but a partially upgraded deployment may still have legacy
				// Critical rows that must not be stranded.
				priority: { in: DISPATCHABLE_PRIORITIES },
				status: FundDistributionStatus.Pending,
				fundWalletId: null,
				transactionId: null,
				TargetWallet: {
					deletedAt: null,
					paymentSourceId,
					PaymentSource: { deletedAt: null },
				},
			},
			select: {
				id: true,
				targetWalletId: true,
				assetUnit: true,
				amount: true,
				TargetWallet: { select: { walletAddress: true } },
			},
			orderBy: { createdAt: 'asc' },
		});

		return requests.map((request) => ({
			id: request.id,
			targetWalletId: request.targetWalletId,
			targetAddress: request.TargetWallet.walletAddress,
			assetUnit: request.assetUnit,
			amount: request.amount,
		}));
	}

	/**
	 * Assign and dispatch the source's unassigned requests across its fund
	 * wallets, "first with funds": hand the whole pending set to the oldest fund
	 * wallet, which claims and sends the subset it can afford; the rest fall
	 * through to the next wallet on the re-query. A wallet claims a request
	 * atomically (setting fundWalletId + the lock), so no request is ever picked
	 * by two wallets.
	 */
	private async dispatchToWallets(fundWallets: FundWalletContext[], paymentSourceId: string): Promise<void> {
		for (const fundWallet of fundWallets) {
			// Re-query each iteration: the previous wallet has already claimed the
			// subset it could afford (their fundWalletId/transactionId are now set),
			// so those drop out and only the still-unassigned remainder falls through.
			const remaining = await this.loadUnassignedRequests(paymentSourceId);
			if (remaining.length === 0) break;
			await processRequestsForFundWallet(fundWallet, remaining);
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
				// Every top-up is batched (single-tier), so there is one send phase.
				await this.runPhase('scan', () => this.scanAndCreateMissingRequests(fundedPaymentSourceIds));
				await this.runPhase('dispatch-batches', () => this.processPendingBatches());
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

	private async scanAndCreateMissingRequests(fundedPaymentSourceIds: string[]): Promise<void> {
		// Every monitored asset on every monitored wallet, not just lovelace.
		// Low-balance rules are keyed per asset, so an operator can already watch
		// USDM or USDCX; scanning only 'lovelace' meant those alerts fired into a
		// top-up path that ignored them.
		//
		// Scoped to payment sources that actually have an enabled fund wallet:
		// without that filter, every low wallet on an unfunded source triggered a
		// getFundWalletsForPaymentSource lookup that could only ever return empty.
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
				// The top-up trigger lives on the rule: only rules with topupEnabled
				// and a topupAmount ask to be funded.
				LowBalanceRules: {
					some: {
						enabled: true,
						topupEnabled: true,
						lastKnownAmount: { not: null },
						lastCheckedAt: { not: null },
					},
				},
			},
			select: {
				id: true,
				paymentSourceId: true,
				LowBalanceRules: {
					where: {
						enabled: true,
						topupEnabled: true,
						lastKnownAmount: { not: null },
						lastCheckedAt: { not: null },
					},
					select: {
						id: true,
						assetUnit: true,
						thresholdAmount: true,
						topupAmount: true,
						lastKnownAmount: true,
						lastCheckedAt: true,
					},
				},
			},
		});

		for (const wallet of monitoredWallets) {
			for (const rule of wallet.LowBalanceRules) {
				if (rule.lastKnownAmount == null || rule.lastCheckedAt == null || rule.topupAmount == null) continue;
				// requestTopup returns early unless the balance is below the rule's
				// threshold; the amount is the rule's own topupAmount.
				await this.requestTopup({
					ruleId: rule.id,
					targetWalletId: wallet.id,
					currentBalance: rule.lastKnownAmount,
					paymentSourceId: wallet.paymentSourceId,
					assetUnit: rule.assetUnit,
					thresholdAmount: rule.thresholdAmount,
					topupAmount: rule.topupAmount,
					balanceCheckedAt: rule.lastCheckedAt,
				});
			}
		}
	}

	private async processPendingBatches(): Promise<void> {
		// Unassigned Pending requests, oldest first, so the first row seen per
		// source is that source's oldest waiting shortage. Critical is included
		// only as an upgrade-compatible alias for the single batched tier.
		const rows = await prisma.fundDistributionRequest.findMany({
			where: {
				priority: { in: DISPATCHABLE_PRIORITIES },
				status: FundDistributionStatus.Pending,
				fundWalletId: null,
				transactionId: null,
				TargetWallet: { deletedAt: null, PaymentSource: { deletedAt: null } },
			},
			select: { createdAt: true, TargetWallet: { select: { paymentSourceId: true } } },
			orderBy: { createdAt: 'asc' },
		});

		if (rows.length === 0) return;

		const oldestBySource = new Map<string, number>();
		for (const row of rows) {
			const sourceId = row.TargetWallet.paymentSourceId;
			if (!oldestBySource.has(sourceId)) oldestBySource.set(sourceId, row.createdAt.getTime());
		}

		const now = Date.now();
		for (const [paymentSourceId, oldestCreatedAt] of oldestBySource) {
			const fundWallets = await getFundWalletsForPaymentSource(paymentSourceId);
			if (fundWallets.length === 0) continue;

			// A source's batch window is the most eager (smallest) of its wallets':
			// adding a faster-cadence wallet speeds the whole source up rather than
			// being held back by a slower one.
			const batchWindowMs = Math.min(
				...fundWallets.map(
					(wallet) => wallet.config.batchWindowMs || CONSTANTS.FUND_DISTRIBUTION_DEFAULT_BATCH_WINDOW_MS,
				),
			);
			if (now - oldestCreatedAt < batchWindowMs) continue;

			await this.dispatchToWallets(fundWallets, paymentSourceId);
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
					batchId: txRequests[0]?.batchId ?? '',
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
