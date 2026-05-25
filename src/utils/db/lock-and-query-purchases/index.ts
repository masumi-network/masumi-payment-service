import { HotWalletType, OnChainState, PaymentSourceType, Prisma, PurchasingAction } from '@/generated/prisma/client';
import { prisma } from '@masumi/payment-core/db';
import { logger } from '@masumi/payment-core/logger';
import { retryOnSerializationConflict } from '@/utils/db/retry';

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
				const perWalletResults = await Promise.all(
					paymentSource.HotWallets.map((hotWallet) =>
						retryOnSerializationConflict(
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
				const purchasingRequests = perWalletResults.flat();
				if (purchasingRequests.length > 0) {
					return {
						...paymentSource,
						PurchaseRequests: purchasingRequests,
					};
				}
				return null;
			}),
		);
		return paymentSourceResults.filter((ps): ps is NonNullable<typeof ps> => ps != null);
	} catch (error) {
		logger.error('Error locking and querying purchases', error);
		throw error;
	}
}
