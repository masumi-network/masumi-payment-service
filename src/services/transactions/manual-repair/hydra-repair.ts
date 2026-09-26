import {
	HydraHeadStatus,
	OnChainState,
	PaymentAction,
	PurchasingAction,
	TransactionLayer,
	TransactionStatus,
	WalletType,
} from '@/generated/prisma/client';
import { prisma } from '@masumi/payment-core/db';
import { retryOnSerializationConflict } from '@masumi/payment-core/db-retry';
import { logger } from '@masumi/payment-core/logger';
import {
	lockHydraMutationAdmission,
	persistedHydraValue,
} from '@/services/hydra-connection-manager/hydra-datum-guards';
import { RepairConflictError, type RepairExpectedVersion, type RepairResult, type RepairTargetKind } from './index';
import { ensureObservedTransaction } from '@/services/hydra-connection-manager/hydra-datum-observation';
import { validateHydraRepair } from './hydra-validation';

/** Restore only the existing initial escrow. This function never submits a transaction. */
export async function repairHydraRequest(params: {
	kind: RepairTargetKind;
	requestId: string;
	txHash: string;
	expectedVersion: RepairExpectedVersion;
}): Promise<RepairResult> {
	const result = await retryOnSerializationConflict(async () => {
		const evidence = await validateHydraRepair(params);
		if (evidence.requestUpdatedAt.getTime() !== params.expectedVersion.updatedAt.getTime()) {
			throw new RepairConflictError(params.requestId);
		}
		return prisma.$transaction(
			async (tx) => {
				if (!(await lockHydraMutationAdmission(tx, evidence.headId))) throw new RepairConflictError(params.requestId);
				const head = await tx.hydraHead.findUnique({
					where: { id: evidence.headId },
					select: { ownerEpoch: true, status: true, isClosing: true, latestSnapshotNumber: true },
				});
				if (
					head?.ownerEpoch !== evidence.ownerEpoch ||
					head.status !== HydraHeadStatus.Open ||
					head.isClosing ||
					head.latestSnapshotNumber !== evidence.snapshotNumber
				) {
					throw new RepairConflictError(params.requestId);
				}
				const select = {
					paymentSourceId: true,
					id: true,
					updatedAt: true,
					nextActionId: true,
					onChainState: true,
					resultHash: true,
					layer: true,
					currentTransactionId: true,
					currentHydraUtxoTxHash: true,
					currentHydraUtxoOutputIndex: true,
					unresolvedHydraTerminalTxHash: true,
					hydraFanoutHandoffHeadId: true,
					CurrentTransaction: { select: { txHash: true, layer: true, hydraHeadId: true, status: true } },
					NextAction: { select: { requestedAction: true } },
				} as const;
				const request =
					params.kind === 'purchase'
						? await tx.purchaseRequest.findUnique({ where: { id: params.requestId }, select })
						: await tx.paymentRequest.findUnique({ where: { id: params.requestId }, select });
				const expected = params.expectedVersion;
				if (
					!request ||
					request.updatedAt.getTime() !== expected.updatedAt.getTime() ||
					request.currentTransactionId !== expected.currentTransactionId ||
					request.onChainState !== expected.onChainState ||
					request.resultHash !== expected.resultHash ||
					request.onChainState !== OnChainState.FundsOrDatumInvalid ||
					request.layer !== TransactionLayer.L2 ||
					request.currentTransactionId !== evidence.currentTransactionId ||
					request.currentHydraUtxoTxHash !== evidence.currentHydraUtxoRef.txHash ||
					request.currentHydraUtxoOutputIndex !== evidence.currentHydraUtxoRef.outputIndex ||
					request.CurrentTransaction?.txHash !== params.txHash ||
					request.CurrentTransaction.layer !== TransactionLayer.L2 ||
					request.CurrentTransaction.hydraHeadId !== evidence.headId ||
					request.CurrentTransaction.status !== TransactionStatus.Confirmed ||
					request.unresolvedHydraTerminalTxHash != null ||
					request.hydraFanoutHandoffHeadId != null
				) {
					throw new RepairConflictError(params.requestId);
				}
				// Only parked requests or the old unsupported lock retry can be repaired.
				const action = request.NextAction.requestedAction;
				if (
					action !== 'WaitingForManualAction' &&
					action !== 'WaitingForExternalAction' &&
					!(params.kind === 'purchase' && action === 'FundsLockingRequested')
				) {
					throw new RepairConflictError(params.requestId);
				}
				evidence.assertFresh();
				const transactionId = await ensureObservedTransaction(tx, {
					hydraHeadId: evidence.headId,
					txId: params.txHash,
					currentTransaction: null,
					previousState: OnChainState.FundsOrDatumInvalid,
					newState: OnChainState.FundsLocked,
				});
				const data = {
					onChainState: OnChainState.FundsLocked,
					resultHash: null,
					currentHydraUtxoValue: persistedHydraValue(evidence.outputAmounts),
					ActionHistory: { connect: { id: request.nextActionId } },
					TransactionHistory: { connect: [{ id: evidence.currentTransactionId }, { id: transactionId }] },
					CurrentTransaction: { connect: { id: transactionId } },
				};
				const where = { id: request.id, updatedAt: request.updatedAt, nextActionId: request.nextActionId };
				if (params.kind === 'purchase') {
					await tx.purchaseRequest.update({
						where,
						data: { ...data, NextAction: { create: { requestedAction: PurchasingAction.WaitingForExternalAction } } },
					});
				} else {
					await tx.paymentRequest.update({
						where,
						data: {
							...data,
							NextAction: { create: { requestedAction: PaymentAction.WaitingForExternalAction } },
							BuyerWallet: {
								connectOrCreate: {
									where: {
										paymentSourceId_walletVkey_walletAddress_type: {
											paymentSourceId: request.paymentSourceId,
											...evidence.buyerWallet,
											type: WalletType.Buyer,
										},
									},
									create: {
										...evidence.buyerWallet,
										type: WalletType.Buyer,
										PaymentSource: { connect: { id: request.paymentSourceId } },
									},
								},
							},
						},
					});
				}
				// The observation retains the same hash without changing other batch members' invalid transaction row.
				evidence.assertFresh();
				return {
					requestId: request.id,
					txHash: params.txHash,
					transactionId,
					previousOnChainState: request.onChainState,
					newOnChainState: OnChainState.FundsLocked,
					forced: false,
				};
			},
			{ isolationLevel: 'Serializable' },
		);
	});
	logger.warn('Hydra request repaired against existing escrow evidence', { kind: params.kind, ...result });
	return result;
}
