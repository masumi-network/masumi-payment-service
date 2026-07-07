import { HotWalletType, PaymentSourceType, RegistrationState } from '@/generated/prisma/client';
import { prisma } from '@masumi/payment-core/db';
import { withSerializableSlotRetry } from '@masumi/payment-core/serializable-semaphore';

export async function lockAndQueryInboxAgentRegistrationRequests({
	state,
	maxBatchSize,
	paymentSourceType,
}: {
	state: RegistrationState;
	maxBatchSize: number;
	paymentSourceType?: PaymentSourceType;
}) {
	const locksSellingWallet = state === RegistrationState.RegistrationRequested;

	// Same retry rationale as the sibling lock-and-query helpers — concurrent
	// scheduler ticks race on HotWallet locks under Serializable isolation.
	// The whole helper runs inside one Serializable transaction (vs the per-wallet
	// fan-out used by the sibling helpers); still gate it on the shared semaphore
	// so it competes fairly for connection budget with the fan-out helpers.
	// See `src/utils/db/serializable-semaphore.ts`.
	return await withSerializableSlotRetry(
		() =>
			prisma.$transaction(
				async (prisma) => {
					const paymentSources = await prisma.paymentSource.findMany({
						where: {
							syncInProgress: false,
							deletedAt: null,
							disablePaymentAt: null,
							...(paymentSourceType != null ? { paymentSourceType } : {}),
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
						for (const hotWallet of paymentSource.HotWallets) {
							const potentialInboxAgentRegistrationRequests = await prisma.inboxAgentRegistrationRequest.findMany({
								where: {
									state,
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
								},
								orderBy: {
									createdAt: 'asc',
								},
								take: maxBatchSize,
							});
							if (potentialInboxAgentRegistrationRequests.length > 0) {
								const hotWalletResult = await prisma.hotWallet.update({
									where: { id: hotWallet.id, deletedAt: null },
									data: { lockedAt: new Date() },
								});
								potentialInboxAgentRegistrationRequests.forEach((request) => {
									const walletToLock =
										locksSellingWallet || request.DeregistrationHotWallet == null
											? request.SmartContractWallet
											: request.DeregistrationHotWallet;
									walletToLock.pendingTransactionId = hotWalletResult.pendingTransactionId;
									walletToLock.lockedAt = hotWalletResult.lockedAt;
								});
								newPaymentSources.push({
									...paymentSource,
									InboxAgentRegistrationRequests: potentialInboxAgentRegistrationRequests,
								});
							}
						}
					}
					return newPaymentSources;
				},
				{ isolationLevel: 'Serializable', timeout: 30_000, maxWait: 30_000 },
			),
		{ label: 'lockAndQueryInboxAgentRegistrationRequests' },
	);
}
