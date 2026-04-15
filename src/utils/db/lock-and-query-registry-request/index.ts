import { HotWalletType, RegistrationState } from '@/generated/prisma/client';
import { CONFIG } from '@/utils/config';
import { prisma } from '../index.js';

export async function lockAndQueryA2ARegistryRequests({
	state,
	maxBatchSize,
}: {
	state: RegistrationState;
	maxBatchSize: number;
}) {
	const locksSellingWallet = state === RegistrationState.RegistrationRequested;

	return await prisma.$transaction(
		async (prisma) => {
			const paymentSources = await prisma.paymentSource.findMany({
				where: {
					syncInProgress: false,
					deletedAt: null,
					disablePaymentAt: null,
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
				const a2aRegistryRequests = [];
				for (const hotWallet of paymentSource.HotWallets) {
					const potentialRequests = await prisma.a2ARegistryRequest.findMany({
						where: {
							state: state,
							SmartContractWallet: {
								id: hotWallet.id,
								deletedAt: null,
								PendingTransaction: { is: null },
								lockedAt: null,
							},
						},
						include: {
							SmartContractWallet: {
								include: {
									Secret: true,
								},
							},
							Pricing: {
								include: { FixedPricing: { include: { Amounts: true } } },
							},
						},
						orderBy: {
							createdAt: 'asc',
						},
						take: maxBatchSize,
					});
					if (potentialRequests.length > 0) {
						const hotWalletResult = await prisma.hotWallet.update({
							where: { id: hotWallet.id, deletedAt: null },
							data: { lockedAt: new Date() },
						});
						potentialRequests.forEach((req) => {
							req.SmartContractWallet.pendingTransactionId = hotWalletResult.pendingTransactionId;
							req.SmartContractWallet.lockedAt = hotWalletResult.lockedAt;
						});
						a2aRegistryRequests.push(...potentialRequests);
					}
				}
				if (a2aRegistryRequests.length > 0) {
					newPaymentSources.push({
						...paymentSource,
						A2ARegistryRequest: a2aRegistryRequests,
					});
				}
			}
			return newPaymentSources;
		},
		{ isolationLevel: 'Serializable', timeout: CONFIG.SYNC_LOCK_TIMEOUT_INTERVAL * 1000 },
	);
}

export async function lockAndQueryRegistryRequests({
	state,
	maxBatchSize,
}: {
	state: RegistrationState;
	maxBatchSize: number;
}) {
	const locksSellingWallet = state === RegistrationState.RegistrationRequested;

	return await prisma.$transaction(
		async (prisma) => {
			const paymentSources = await prisma.paymentSource.findMany({
				where: {
					syncInProgress: false,
					deletedAt: null,
					disablePaymentAt: null,
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
		{ isolationLevel: 'Serializable', timeout: CONFIG.SYNC_LOCK_TIMEOUT_INTERVAL * 1000 },
	);
}
