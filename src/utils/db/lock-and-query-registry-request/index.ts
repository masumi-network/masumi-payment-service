import { HotWalletType, PaymentSourceType, RegistrationState } from '@/generated/prisma/client';
import { prisma } from '@masumi/payment-core/db';
import { retryOnSerializationConflict } from '@/utils/db/retry';
import { withSerializableSlot } from '@/utils/db/serializable-semaphore';

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
			const perWalletResults = await Promise.all(
				paymentSource.HotWallets.map((hotWallet) =>
					// Gate every Serializable transaction through the shared semaphore so the
					// per-wallet fan-out across sources cannot exhaust the pg connection pool.
					// See `src/utils/db/serializable-semaphore.ts` for sizing rationale.
					withSerializableSlot(() =>
						retryOnSerializationConflict(
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
				),
			);
			const registryRequests = perWalletResults.flat();
			if (registryRequests.length > 0) {
				return {
					...paymentSource,
					RegistryRequest: registryRequests,
				};
			}
			return null;
		}),
	);
	return paymentSourceResults.filter((ps): ps is NonNullable<typeof ps> => ps != null);
}
