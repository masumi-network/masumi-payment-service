import createHttpError from 'http-errors';
import { CONFIG } from '@masumi/payment-core/config';
import { prisma } from '@masumi/payment-core/db';
import { withSerializableSlotRetry } from '@masumi/payment-core/serializable-semaphore';
import {
	HydraHeadStatus,
	type Network,
	OnChainState,
	Prisma,
	TransactionLayer,
	TransactionStatus,
} from '@/generated/prisma/client';
import { getHydraConnectionManager } from '@/services/hydra-connection-manager/hydra-connection-manager.service';
import { lookupConfirmedChainTx } from '@/services/shared/chain-tx-lookup';

const settledTerminalStates = [OnChainState.Withdrawn, OnChainState.RefundWithdrawn] as const;

const safelySettledTerminalRequestWhere = {
	layer: TransactionLayer.L2,
	onChainState: { in: [...settledTerminalStates] },
	currentHydraUtxoTxHash: null,
	currentHydraUtxoOutputIndex: null,
	currentHydraUtxoValue: { equals: Prisma.DbNull },
	unresolvedHydraTerminalTxHash: null,
	unresolvedHydraTerminalReason: null,
	hydraFanoutHandoffHeadId: null,
	hydraFanoutHandoffTxHash: null,
	hydraFanoutHandoffOutputIndex: null,
	CurrentTransaction: {
		is: {
			layer: TransactionLayer.L2,
			status: TransactionStatus.Confirmed,
			txHash: { not: null },
		},
	},
};

export const unsettledL2TransactionWhere = {
	layer: TransactionLayer.L2,
	OR: [
		{ status: TransactionStatus.Pending },
		{ PaymentRequestCurrent: { some: { NOT: safelySettledTerminalRequestWhere } } },
		{ PurchaseRequestCurrent: { some: { NOT: safelySettledTerminalRequestWhere } } },
	],
} satisfies Prisma.TransactionWhereInput;

const cleanupRequestSelect = {
	layer: true,
	onChainState: true,
	currentHydraUtxoTxHash: true,
	currentHydraUtxoOutputIndex: true,
	currentHydraUtxoValue: true,
	unresolvedHydraTerminalTxHash: true,
	unresolvedHydraTerminalReason: true,
	hydraFanoutHandoffHeadId: true,
	hydraFanoutHandoffTxHash: true,
	hydraFanoutHandoffOutputIndex: true,
	CurrentTransaction: { select: { status: true, txHash: true } },
} as const;

type CleanupRequest = Prisma.PaymentRequestGetPayload<{ select: typeof cleanupRequestSelect }>;

type HydraCleanupEvidence = {
	headId: string;
	fanoutTxHash: string;
	network: Network;
	rpcProviderApiKey: string;
};

function isSafelySettledTerminalRequest(request: CleanupRequest): boolean {
	return (
		request.layer === TransactionLayer.L2 &&
		request.onChainState != null &&
		settledTerminalStates.includes(request.onChainState as (typeof settledTerminalStates)[number]) &&
		request.CurrentTransaction?.status === TransactionStatus.Confirmed &&
		request.CurrentTransaction.txHash != null &&
		/^[0-9a-f]{64}$/.test(request.CurrentTransaction.txHash) &&
		request.currentHydraUtxoTxHash == null &&
		request.currentHydraUtxoOutputIndex == null &&
		request.currentHydraUtxoValue == null &&
		request.unresolvedHydraTerminalTxHash == null &&
		request.unresolvedHydraTerminalReason == null &&
		request.hydraFanoutHandoffHeadId == null &&
		request.hydraFanoutHandoffTxHash == null &&
		request.hydraFanoutHandoffOutputIndex == null
	);
}

/** Exact application-level counterpart to unsettledL2TransactionWhere. */
export async function hasUnsettledHydraRequestState(
	tx: Prisma.TransactionClient,
	headIds: readonly string[],
): Promise<boolean> {
	if (headIds.length === 0) return false;
	const where = {
		CurrentTransaction: {
			is: {
				hydraHeadId: { in: [...headIds] },
				layer: TransactionLayer.L2,
			},
		},
	};
	const [payments, purchases] = await Promise.all([
		tx.paymentRequest.findMany({ where, select: cleanupRequestSelect }),
		tx.purchaseRequest.findMany({ where, select: cleanupRequestSelect }),
	]);
	return [...payments, ...purchases].some((request) => !isSafelySettledTerminalRequest(request));
}

/**
 * Lock and verify that independently confirmed, fully adopted heads are safe
 * to quiesce. The optional mutation is deliberately run only after the local
 * transport has drained: otherwise an authenticated rollback already queued
 * behind this row lock could observe `isEnabled=false`, be discarded, and let
 * deletion consume stale Final/reconciliation markers.
 */
async function assertHydraHeadsCleanupEligible(
	uniqueHeadIds: readonly string[],
	options: {
		disable: boolean;
		expectedFanoutTxHashes?: ReadonlyMap<string, string>;
		requireDisabled?: boolean;
	},
): Promise<HydraCleanupEvidence[]> {
	return await withSerializableSlotRetry(
		() =>
			prisma.$transaction(
				async (tx) => {
					const lockedHeads = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
						SELECT "id"
						FROM "HydraHead"
						WHERE "id" IN (${Prisma.join(uniqueHeadIds)})
						ORDER BY "id"
						FOR UPDATE
					`);
					if (lockedHeads.length !== uniqueHeadIds.length) {
						throw createHttpError(409, 'Cannot delete missing Hydra configuration');
					}

					const heads = await tx.hydraHead.findMany({
						where: { id: { in: [...uniqueHeadIds] } },
						select: {
							id: true,
							isEnabled: true,
							status: true,
							fanoutTxHash: true,
							reconciliationCompletedAt: true,
							HydraRelation: {
								select: {
									network: true,
									LocalHotWallet: {
										select: {
											PaymentSource: {
												select: {
													network: true,
													PaymentSourceConfig: { select: { rpcProviderApiKey: true } },
												},
											},
										},
									},
								},
							},
							_count: { select: { Transactions: { where: unsettledL2TransactionWhere } } },
						},
					});
					const [paymentHandoffs, purchaseHandoffs] = await Promise.all([
						tx.paymentRequest.count({
							where: { hydraFanoutHandoffHeadId: { in: [...uniqueHeadIds] } },
						}),
						tx.purchaseRequest.count({
							where: { hydraFanoutHandoffHeadId: { in: [...uniqueHeadIds] } },
						}),
					]);
					const hasUnsettledRequests = await hasUnsettledHydraRequestState(tx, uniqueHeadIds);
					const unsafeHead = heads.find(
						(head) =>
							(options.requireDisabled === true && head.isEnabled) ||
							head.status !== HydraHeadStatus.Final ||
							head.fanoutTxHash == null ||
							!/^[0-9a-f]{64}$/.test(head.fanoutTxHash) ||
							(options.expectedFanoutTxHashes != null &&
								options.expectedFanoutTxHashes.get(head.id) !== head.fanoutTxHash) ||
							head.reconciliationCompletedAt == null ||
							head.HydraRelation.network !== head.HydraRelation.LocalHotWallet.PaymentSource.network ||
							head.HydraRelation.LocalHotWallet.PaymentSource.PaymentSourceConfig.rpcProviderApiKey.length === 0 ||
							head._count.Transactions !== 0,
					);
					if (unsafeHead || paymentHandoffs !== 0 || purchaseHandoffs !== 0 || hasUnsettledRequests) {
						throw createHttpError(
							409,
							'Cannot delete Hydra configuration before fanout is independently confirmed and all L2 handoffs are adopted',
						);
					}

					if (options.disable) {
						const disabled = await tx.hydraHead.updateMany({
							where: {
								id: { in: [...uniqueHeadIds] },
								status: HydraHeadStatus.Final,
								fanoutTxHash: { not: null },
								reconciliationCompletedAt: { not: null },
								Transactions: { none: unsettledL2TransactionWhere },
							},
							data: { isEnabled: false },
						});
						if (disabled.count !== uniqueHeadIds.length) {
							throw createHttpError(409, 'Hydra head cleanup eligibility changed concurrently');
						}
					}

					return heads.map((head) => ({
						headId: head.id,
						fanoutTxHash: head.fanoutTxHash!,
						network: head.HydraRelation.network,
						rpcProviderApiKey: head.HydraRelation.LocalHotWallet.PaymentSource.PaymentSourceConfig.rpcProviderApiKey,
					}));
				},
				{
					isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
					maxWait: 10_000,
					timeout: 10_000,
				},
			),
		{ label: options.disable ? 'hydra-head-disable-for-deletion' : 'hydra-head-deletion-preflight' },
	);
}

async function assertHydraFanoutStillFinal(evidence: readonly HydraCleanupEvidence[]): Promise<void> {
	const results = await Promise.all(
		evidence.map(async (head) => ({
			headId: head.headId,
			result: await lookupConfirmedChainTx({
				network: head.network,
				rpcProviderApiKey: head.rpcProviderApiKey,
				txHash: head.fanoutTxHash,
				requiredConfirmations: CONFIG.BLOCK_CONFIRMATIONS_THRESHOLD,
			}),
		})),
	);
	if (results.some(({ result }) => result === 'transient-error')) {
		throw createHttpError(503, 'Cannot independently re-confirm Hydra fanout finality');
	}
	if (results.some(({ result }) => result !== 'confirmed-valid')) {
		throw createHttpError(409, 'Cannot delete Hydra configuration after fanout finality changed');
	}
}

/**
 * Drain every local evidence transport, then lock, recheck and make the heads
 * durably ineligible. Queue one final manager reconciliation behind any
 * concurrent reconnect and recheck the locked evidence before deleting
 * identity/evidence rows.
 */
export async function quiesceHydraHeadsForDeletion(headIds: readonly string[]): Promise<void> {
	const uniqueHeadIds = [...new Set(headIds)];
	if (uniqueHeadIds.length === 0) return;

	// Avoid disconnecting an active/unsafe head merely because an administrator
	// attempted an invalid deletion.
	const cleanupEvidence = await assertHydraHeadsCleanupEligible(uniqueHeadIds, { disable: false });
	const expectedFanoutTxHashes = new Map(cleanupEvidence.map(({ headId, fanoutTxHash }) => [headId, fanoutTxHash]));

	const manager = getHydraConnectionManager();
	try {
		for (const headId of uniqueHeadIds) await manager.disconnect(headId);
		await assertHydraFanoutStillFinal(cleanupEvidence);
		await assertHydraHeadsCleanupEligible(uniqueHeadIds, { disable: true, expectedFanoutTxHashes });
		const quiescence = await Promise.allSettled(
			uniqueHeadIds.map(async (headId) => await manager.reconcileEnabledState(headId)),
		);
		const quiescenceFailure = quiescence.find(
			(result): result is PromiseRejectedResult => result.status === 'rejected',
		);
		if (quiescenceFailure) throw quiescenceFailure.reason;
		await assertHydraHeadsCleanupEligible(uniqueHeadIds, {
			disable: false,
			expectedFanoutTxHashes,
			requireDisabled: true,
		});
	} catch (error) {
		// A rollback can legitimately make the second eligibility check fail.
		// Restore transports only for heads whose durable state still permits it;
		// quarantined/disabled heads remain disconnected.
		await Promise.allSettled(uniqueHeadIds.map(async (headId) => await manager.reconcileEnabledState(headId)));
		throw error;
	}
}

export const reconciledFinalHeadFilter = {
	status: HydraHeadStatus.Final,
	isEnabled: false,
	fanoutTxHash: { not: null },
	reconciliationCompletedAt: { not: null },
	Transactions: { none: unsettledL2TransactionWhere },
} as const;
