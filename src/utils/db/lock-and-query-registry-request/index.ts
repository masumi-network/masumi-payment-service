import { HotWalletType, PaymentSourceType, RegistrationState } from '@/generated/prisma/client';
import { prisma } from '@masumi/payment-core/db';
import { retryOnSerializationConflict } from '@/utils/db/retry';

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

	// Serializable isolation conflicts with concurrent scheduler ticks
	// (e.g. V1 + V2 register firing at the same time on a shared API server).
	// retryOnSerializationConflict catches Prisma P2034 and retries with
	// jittered backoff so transient conflicts don't surface as request
	// failures.
	return await retryOnSerializationConflict(
		() =>
			prisma.$transaction(
				async (prisma) => {
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

					const newPaymentSources = [];
					for (const paymentSource of paymentSources) {
						const registryRequests = [];
						for (const hotWallet of paymentSource.HotWallets) {
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
								registryRequests.push(...potentialRegistryRequests);
							}
						}
						if (registryRequests.length > 0) {
							newPaymentSources.push({
								...paymentSource,
								RegistryRequest: registryRequests,
							});
						}
					}
					return newPaymentSources;
				},
				{ isolationLevel: 'Serializable', timeout: 30_000, maxWait: 30_000 },
			),
		{ label: 'lockAndQueryRegistryRequests' },
	);
}
