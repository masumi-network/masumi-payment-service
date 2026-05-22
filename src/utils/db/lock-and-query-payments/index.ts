import { HotWalletType, OnChainState, PaymentAction, PaymentSourceType } from '@/generated/prisma/client';
import { prisma } from '@masumi/payment-core/db';
import { retryOnSerializationConflict } from '@/utils/db/retry';

export async function lockAndQueryPayments({
	paymentStatus,
	maxBatchSize,
	submitResultTime = undefined,
	onChainState = undefined,
	resultHash = undefined,
	requestedResultHash = undefined,
	unlockTime = undefined,
	paymentSourceType = undefined,
}: {
	paymentStatus: PaymentAction | { in: PaymentAction[] };
	submitResultTime?: { lte?: number; gte?: number; lt?: number; gt?: number } | undefined;
	onChainState?: OnChainState | { in: OnChainState[] } | undefined;
	resultHash?: string | { not: string | null } | undefined;
	requestedResultHash?: string | { not: null } | undefined;
	unlockTime?: { lte?: number; gte?: number; lt?: number; gt?: number } | undefined;
	paymentSourceType?: PaymentSourceType;
	maxBatchSize: number;
}) {
	// Wrapped in retryOnSerializationConflict so concurrent scheduler ticks
	// (V1 + V2 share this codepath under different paymentSourceType filters)
	// don't surface transient Prisma P2034 / Postgres 40001 errors as failed
	// jobs. See [retry.ts] for the conflict semantics.
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

					const newPaymentSources = [];
					for (const paymentSource of paymentSources) {
						const paymentRequests = [];
						const minCooldownTime = paymentSource.cooldownTime;
						for (const hotWallet of paymentSource.HotWallets) {
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
								paymentRequests.push(...potentialPaymentRequests);
							}
						}

						if (paymentRequests.length > 0) {
							newPaymentSources.push({
								...paymentSource,
								PaymentRequests: paymentRequests,
							});
						}
					}
					return newPaymentSources;
				},
				{ isolationLevel: 'Serializable', timeout: 30_000, maxWait: 30_000 },
			),
		{ label: 'lockAndQueryPayments' },
	);
}
