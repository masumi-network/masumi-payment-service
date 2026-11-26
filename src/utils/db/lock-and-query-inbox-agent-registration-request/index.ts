import { HotWalletType, PaymentSourceType, Prisma, RegistrationState } from '@/generated/prisma/client';
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
	const paymentSourceWhere: Prisma.PaymentSourceWhereInput = {
		syncInProgress: false,
		deletedAt: null,
		disablePaymentAt: null,
		...(paymentSourceType != null ? { paymentSourceType } : {}),
	};
	const hotWalletWhere: Prisma.HotWalletWhereInput = {
		...(locksSellingWallet ? { type: HotWalletType.Selling } : {}),
		PendingTransaction: null,
		lockedAt: null,
		deletedAt: null,
	};
	// The one request filter, shared by the gate and the per-wallet query so the
	// two cannot drift apart.
	const buildRequestWhere = (wallet: Prisma.HotWalletWhereInput): Prisma.InboxAgentRegistrationRequestWhereInput => ({
		state,
		...(locksSellingWallet
			? { SmartContractWallet: wallet }
			: {
					OR: [
						{ DeregistrationHotWallet: { is: wallet } },
						{ deregistrationHotWalletId: null, SmartContractWallet: wallet },
					],
				}),
	});

	// Step 0: one cheap existence check outside any transaction. Most ticks find
	// nothing, and without this an idle tick still opens a Serializable
	// transaction. The filter matches any eligible wallet, so it is a superset of
	// the per-wallet one and a miss proves the query below would find nothing.
	const candidate = await prisma.inboxAgentRegistrationRequest.findFirst({
		where: buildRequestWhere({ ...hotWalletWhere, PaymentSource: paymentSourceWhere }),
		select: { id: true },
	});
	if (candidate == null) return [];

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
						where: paymentSourceWhere,
						include: {
							HotWallets: {
								include: {
									Secret: true,
								},
								where: hotWalletWhere,
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
								where: buildRequestWhere({
									id: hotWallet.id,
									deletedAt: null,
									PendingTransaction: { is: null },
									lockedAt: null,
								}),
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
