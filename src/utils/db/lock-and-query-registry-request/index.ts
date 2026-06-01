import { HotWalletType, PaymentSourceType, RegistrationState } from '@/generated/prisma/client';
import { prisma } from '@masumi/payment-core/db';
import { logger } from '@masumi/payment-core/logger';
import { withSerializableSlotRetry } from '@/utils/db/serializable-semaphore';

export async function lockAndQueryRegistryRequests({
	state,
	maxBatchSize,
	paymentSourceType,
}: {
	state: RegistrationState;
	maxBatchSize: number;
	paymentSourceType: PaymentSourceType;
}) {
	const locksSellingWallet = state === RegistrationState.RegistrationRequested;

	// Step 1: read candidate payment sources + unlocked hot wallets. The
	// per-wallet $transaction below provides Serializable isolation around
	// the actual lock — see lockAndQueryPayments for the rationale.
	const paymentSources = await prisma.paymentSource.findMany({
		where: {
			syncInProgress: false,
			deletedAt: null,
			disablePaymentAt: null,
			paymentSourceType,
		},
		include: {
			HotWallets: {
				include: {
					Secret: true,
				},
				where: {
					...(locksSellingWallet ? { type: HotWalletType.Selling } : {}),
					PendingTransaction: null,
					lockedAt: null,
					deletedAt: null,
				},
			},
			AdminWallets: true,
			FeeReceiverNetworkWallet: true,
			PaymentSourceConfig: true,
		},
	});

	// Step 2: per-wallet Serializable transactions in parallel. Independent
	// wallets hold disjoint row locks, so concurrency here doesn't cause
	// extra contention while it does avoid serializing the whole batch on
	// one connection.
	const paymentSourceResults = await Promise.all(
		paymentSources.map(async (paymentSource) => {
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
									const potentialRegistryRequests = await prisma.registryRequest.findMany({
										where: {
											state: state,
											...(locksSellingWallet
												? {
														SmartContractWallet: {
															id: hotWallet.id,
															deletedAt: null,
															PendingTransaction: { is: null },
															lockedAt: null,
														},
													}
												: {
														OR: [
															{
																DeregistrationHotWallet: {
																	is: {
																		id: hotWallet.id,
																		deletedAt: null,
																		PendingTransaction: { is: null },
																		lockedAt: null,
																	},
																},
															},
															{
																deregistrationHotWalletId: null,
																SmartContractWallet: {
																	id: hotWallet.id,
																	deletedAt: null,
																	PendingTransaction: { is: null },
																	lockedAt: null,
																},
															},
														],
													}),
										},
										include: {
											SmartContractWallet: {
												include: {
													Secret: true,
												},
											},
											RecipientWallet: true,
											DeregistrationHotWallet: {
												include: {
													Secret: true,
												},
											},
											Pricing: {
												include: { FixedPricing: { include: { Amounts: true } } },
											},
											ExampleOutputs: true,
											SupportedPaymentSources: true,
										},
										orderBy: {
											createdAt: 'asc',
										},
										take: maxBatchSize,
									});
									if (potentialRegistryRequests.length > 0) {
										const hotWalletResult = await prisma.hotWallet.update({
											where: { id: hotWallet.id, deletedAt: null },
											data: { lockedAt: new Date() },
										});
										potentialRegistryRequests.forEach((registryRequest) => {
											const walletToLock =
												locksSellingWallet || registryRequest.DeregistrationHotWallet == null
													? registryRequest.SmartContractWallet
													: registryRequest.DeregistrationHotWallet;
											walletToLock.pendingTransactionId = hotWalletResult.pendingTransactionId;
											walletToLock.lockedAt = hotWalletResult.lockedAt;
										});
									}
									return potentialRegistryRequests;
								},
								{ isolationLevel: 'Serializable', timeout: 30_000, maxWait: 30_000 },
							),
						{ label: 'lockAndQueryRegistryRequests' },
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
				logger.error('lockAndQueryRegistryRequests: per-wallet lock transaction failed', {
					paymentSourceId: paymentSource.id,
					hotWalletId: paymentSource.HotWallets[index]?.id,
					error: reason,
				});
				return [];
			});
			const walletScopedPaymentSources = perWalletResults.flatMap((registryRequests) => {
				if (registryRequests.length === 0) return [];
				return [
					{
						...paymentSource,
						RegistryRequest: registryRequests,
					},
				];
			});
			return walletScopedPaymentSources;
		}),
	);
	return paymentSourceResults.flat();
}
