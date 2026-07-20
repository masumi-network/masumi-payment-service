import { FundDistributionPriority, FundDistributionStatus, HotWalletType } from '@/generated/prisma/client';
import { prisma } from '@masumi/payment-core/db';
import { CONSTANTS } from '@masumi/payment-core/config';
import { logger } from '@masumi/payment-core/logger';
import { Mutex } from 'async-mutex';
import { withJobLock } from '@/services/shared/job-runner';
import { getFundWalletsForPaymentSource, type FundWalletContext } from './context';
import { processRequestsForFundWallet } from './batch-executor';
import { reconcileInFlightRequests, confirmSubmittedRequests } from './lifecycle';

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
			await this.runPhase('reconcile-in-flight', () => reconcileInFlightRequests());

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
			await this.runPhase('confirm', () => confirmSubmittedRequests());
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
}

export const fundDistributionService = new FundDistributionService();
