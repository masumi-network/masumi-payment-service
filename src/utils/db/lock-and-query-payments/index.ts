import { HotWalletType, OnChainState, PaymentAction, PaymentSourceType, Prisma } from '@/generated/prisma/client';
import { prisma } from '@masumi/payment-core/db';
import { logger } from '@masumi/payment-core/logger';
import { withSerializableSlotRetry } from '@masumi/payment-core/serializable-semaphore';

export async function lockAndQueryPayments({
	paymentStatus,
	maxBatchSize,
	submitResultTime = undefined,
	onChainState = undefined,
	resultHash = undefined,
	requestedResultHash = undefined,
	unlockTime = undefined,
	paymentSourceType = undefined,
	orFilters = undefined,
}: {
	paymentStatus: PaymentAction | { in: PaymentAction[] };
	submitResultTime?: { lte?: number; gte?: number; lt?: number; gt?: number } | undefined;
	onChainState?: OnChainState | { in: OnChainState[] } | undefined;
	resultHash?: string | { not: string | null } | undefined;
	requestedResultHash?: string | { not: null } | undefined;
	unlockTime?: { lte?: number; gte?: number; lt?: number; gt?: number } | undefined;
	paymentSourceType?: PaymentSourceType;
	maxBatchSize: number;
	// Optional disjunction merged into the request `where` clause. Lets a
	// caller batch two query variants in one tick (e.g. timed-unlock vs
	// authorized-withdrawal branches that share paymentStatus + wallet
	// constraints but diverge on onChainState / unlockTime). The
	// per-variant predicates that vary go in `orFilters`; common
	// predicates (paymentStatus, resultHash, etc.) stay in the top-level
	// params and are ANDed with the OR group as usual.
	orFilters?: Prisma.PaymentRequestWhereInput[];
}) {
	// Step 1: read the candidate payment sources + their unlocked hot wallets
	// outside any transaction. This is a read-only snapshot used purely to
	// fan out per-wallet locking transactions below. The per-wallet
	// transactions take row locks at Serializable isolation, so the actual
	// concurrency-safety guarantees live there — not in this read.
	const paymentSources = await prisma.paymentSource.findMany({
		where: {
			syncInProgress: false,
			deletedAt: null,
			disablePaymentAt: null,
			paymentSourceType,
		},
		include: {
			HotWallets: {
				where: {
					PendingTransaction: { is: null },
					lockedAt: null,
					deletedAt: null,
					type: HotWalletType.Selling,
				},
			},
			AdminWallets: true,
			FeeReceiverNetworkWallet: true,
			PaymentSourceConfig: true,
		},
		orderBy: {
			createdAt: 'asc',
		},
	});

	// Step 2: one independent Serializable transaction per (paymentSource,
	// hotWallet) in parallel. No explicit `SELECT ... FOR UPDATE`; concurrent
	// ticks selecting the same wallet are serialized by Postgres SSI (loser
	// aborts with 40001, retried by retryOnSerializationConflict). Net: one
	// wallet, one committed lock per tick.
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
									const potentialPaymentRequests = await prisma.paymentRequest.findMany({
										where: {
											NextAction: {
												requestedAction: paymentStatus,
												errorType: null,
												resultHash: requestedResultHash,
											},
											submitResultTime: submitResultTime,
											unlockTime: unlockTime,
											SmartContractWallet: {
												id: hotWallet.id,
												PendingTransaction: { is: null },
												lockedAt: null,
												deletedAt: null,
											},
											onChainState: onChainState,
											//we only want to lock the payment if the cooldown time has passed
											sellerCoolDownTime: { lt: Date.now() - minCooldownTime },
											resultHash: resultHash,
											// Optional OR group — only included when caller supplies
											// `orFilters`. Each entry is fully ANDed against the
											// outer predicates, so callers can supply per-variant
											// onChainState / time-window constraints that differ
											// across an `OR` axis.
											...(orFilters != null && orFilters.length > 0 ? { OR: orFilters } : {}),
										},
										include: {
											NextAction: true,
											CurrentTransaction: true,
											RequestedFunds: true,
											BuyerWallet: true,
											SmartContractWallet: {
												include: {
													Secret: true,
												},
												where: { deletedAt: null },
											},
										},
										orderBy: {
											createdAt: 'asc',
										},
										take: maxBatchSize,
									});
									if (potentialPaymentRequests.length > 0) {
										const hotWalletResult = await prisma.hotWallet.update({
											where: { id: hotWallet.id, deletedAt: null },
											data: { lockedAt: new Date() },
										});
										potentialPaymentRequests.forEach((paymentRequest) => {
											paymentRequest.SmartContractWallet!.pendingTransactionId = hotWalletResult.pendingTransactionId;
											paymentRequest.SmartContractWallet!.lockedAt = hotWalletResult.lockedAt;
										});
									}
									return potentialPaymentRequests;
								},
								{ isolationLevel: 'Serializable', timeout: 30_000, maxWait: 30_000 },
							),
						{ label: 'lockAndQueryPayments' },
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
				logger.error('lockAndQueryPayments: per-wallet lock transaction failed', {
					paymentSourceId: paymentSource.id,
					hotWalletId: paymentSource.HotWallets[index]?.id,
					error: reason,
				});
				return [];
			});
			const walletScopedPaymentSources = perWalletResults.flatMap((paymentRequests) => {
				if (paymentRequests.length === 0) return [];
				return [
					{
						...paymentSource,
						PaymentRequests: paymentRequests,
					},
				];
			});
			return walletScopedPaymentSources;
		}),
	);
	return paymentSourceResults.flat();
}
