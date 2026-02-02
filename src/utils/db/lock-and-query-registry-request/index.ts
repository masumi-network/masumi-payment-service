import { HotWalletType, RegistrationState } from '@/generated/prisma/client';
import { prisma } from '../index.js';

export async function lockAndQueryRegistryRequests({
	state,
	maxBatchSize,
}: {
	state: RegistrationState;
	maxBatchSize: number;
}) {
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
							type: HotWalletType.Selling,
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
							registryRequest.SmartContractWallet.pendingTransactionId = hotWalletResult.pendingTransactionId;
							registryRequest.SmartContractWallet.lockedAt = hotWalletResult.lockedAt;
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
		{ isolationLevel: 'Serializable', timeout: 1000000 },
	);
}
