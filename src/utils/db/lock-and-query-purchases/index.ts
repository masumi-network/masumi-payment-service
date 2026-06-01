import { HotWalletType, OnChainState, PaymentSourceType, Prisma, PurchasingAction } from '@/generated/prisma/client';
import { prisma } from '@masumi/payment-core/db';
import { logger } from '@masumi/payment-core/logger';
import { withSerializableSlotRetry } from '@/utils/db/serializable-semaphore';

export async function lockAndQueryPurchases({
	purchasingAction,
	maxBatchSize,
	unlockTime,
	onChainState = undefined,
	submitResultTime = undefined,
	resultHash = undefined,
	paymentSourceType = undefined,
	orFilters = undefined,
}: {
	purchasingAction: PurchasingAction;
	unlockTime?: { lte?: number; gte?: number; lt?: number; gt?: number } | undefined;
	onChainState?: OnChainState | { in: OnChainState[] } | undefined;
	submitResultTime?: { lte?: number; gte?: number; lt?: number; gt?: number } | undefined;
	resultHash?: string | null | undefined;
	paymentSourceType?: PaymentSourceType;
	maxBatchSize: number;
	// Optional disjunction merged into the request `where` clause. Lets a
	// caller batch two query variants in one tick (e.g. timed-refund vs
	// authorized-refund branches that share purchasingAction + wallet
	// constraints but diverge on onChainState / submitResultTime). The
	// per-variant predicates that vary go in `orFilters`; common
	// predicates (purchasingAction, resultHash, etc.) stay in the
	// top-level params and are ANDed with the OR group as usual.
	orFilters?: Prisma.PurchaseRequestWhereInput[];
}) {
	try {
		// Step 1: read the candidate payment sources + their unlocked hot
		// wallets outside any transaction. See lockAndQueryPayments for the
		// rationale: the per-wallet $transaction below holds the lock that
		// matters; this query is just a read-only fan-out source.
		const paymentSources = await prisma.paymentSource.findMany({
			where: {
				syncInProgress: false,
				deletedAt: null,
				disablePaymentAt: null,
				paymentSourceType,
			},
			include: {
				AdminWallets: true,
				FeeReceiverNetworkWallet: true,
				PaymentSourceConfig: true,
				HotWallets: {
					where: {
						PendingTransaction: { is: null },
						lockedAt: null,
						deletedAt: null,
						type: HotWalletType.Purchasing,
					},
					select: {
						id: true,
					},
				},
			},
		});

		// Step 2: per-wallet Serializable transactions in parallel. Wallets
		// hold disjoint row locks so concurrent fan-out is safe and avoids
		// queuing the whole batch on a single transaction connection.
		const paymentSourceResults = await Promise.all(
			paymentSources.map(async (paymentSource) => {
				const minCooldownTime = paymentSource.cooldownTime;
				// Use allSettled (not all): each per-wallet transaction commits its
				// own `lockedAt` lock before this fan-out resolves. With all-or-nothing
				// `Promise.all`, one wallet exhausting its retry budget would reject the
				// whole batch and discard the already-committed locks of every sibling
				// wallet, leaving them stuck until the wallet-lock-timeout reaper frees
				// them (~5 min). Settle and collect successes instead; log failures.
				const settledPerWalletResults = await Promise.allSettled(
					paymentSource.HotWallets.map((hotWallet) =>
						// Gate every Serializable transaction through the shared semaphore so the
						// per-wallet fan-out across sources cannot exhaust the pg connection pool.
						// See `src/utils/db/serializable-semaphore.ts` for sizing rationale.
						withSerializableSlotRetry(
							() =>
								prisma.$transaction(
									async (prisma) => {
										const potentialPurchasingRequests = await prisma.purchaseRequest.findMany({
											where: {
												buyerCoolDownTime: { lt: Date.now() - minCooldownTime },
												submitResultTime: submitResultTime,
												unlockTime: unlockTime,
												NextAction: {
													requestedAction: purchasingAction,
													errorType: null,
												},
												resultHash: resultHash,
												onChainState: onChainState,
												SmartContractWallet: {
													id: hotWallet.id,
													PendingTransaction: { is: null },
													lockedAt: null,
													deletedAt: null,
												},
												// Optional OR group — only included when caller supplies
												// `orFilters`. Each entry is fully ANDed against the
												// outer predicates, so callers can supply per-variant
												// onChainState / time-window constraints that differ
												// across an `OR` axis.
												...(orFilters != null && orFilters.length > 0 ? { OR: orFilters } : {}),
											},
											orderBy: {
												createdAt: 'asc',
											},
											include: {
												NextAction: true,
												CurrentTransaction: true,
												PaidFunds: true,
												SellerWallet: true,
												SmartContractWallet: {
													include: {
														Secret: true,
													},
												},
											},
											take: maxBatchSize,
										});
										if (potentialPurchasingRequests.length > 0) {
											const hotWalletResult = await prisma.hotWallet.update({
												where: { id: hotWallet.id, deletedAt: null },
												data: { lockedAt: new Date() },
											});
											potentialPurchasingRequests.forEach((purchasingRequest) => {
												purchasingRequest.SmartContractWallet!.pendingTransactionId =
													hotWalletResult.pendingTransactionId;
												purchasingRequest.SmartContractWallet!.lockedAt = hotWalletResult.lockedAt;
											});
										}
										return potentialPurchasingRequests;
									},
									{ isolationLevel: 'Serializable', timeout: 30_000, maxWait: 30_000 },
								),
							{ label: 'lockAndQueryPurchases' },
						),
					),
				);
				// Keep order-aligned with HotWallets so a rejected slot can be traced
				// back to the wallet that failed. Successful slots already committed
				// their lock, so we still return their rows exactly as before.
				const perWalletResults = settledPerWalletResults.map((result, index) => {
					if (result.status === 'fulfilled') {
						return result.value;
					}
					// `PromiseRejectedResult.reason` is typed `any`; launder it to
					// `unknown` so logging it does not trip no-unsafe-assignment.
					const reason: unknown = result.reason;
					logger.error('lockAndQueryPurchases: per-wallet lock transaction failed', {
						paymentSourceId: paymentSource.id,
						hotWalletId: paymentSource.HotWallets[index]?.id,
						error: reason,
					});
					return [];
				});
				const walletScopedPaymentSources = perWalletResults.flatMap((purchasingRequests) => {
					if (purchasingRequests.length === 0) return [];
					return [
						{
							...paymentSource,
							PurchaseRequests: purchasingRequests,
						},
					];
				});
				return walletScopedPaymentSources;
			}),
		);
		return paymentSourceResults.flat();
	} catch (error) {
		logger.error('Error locking and querying purchases', error);
		throw error;
	}
}
