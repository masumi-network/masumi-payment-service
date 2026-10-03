/**
 * Recording that a transaction was observed, and releasing what it held.
 *
 * Split from hydra-datum-sync when it passed the 750-line limit. These are the
 * two effects every datum path shares regardless of what the datum turned out
 * to mean: the observed-transaction row that makes replay idempotent, and the
 * wallet a settled request no longer blocks.
 *
 * A leaf, like the guards: nothing here reads the datum flow's decisions.
 */

import { OnChainState, Prisma, TransactionLayer, TransactionStatus } from '@/generated/prisma/client';

export async function ensureObservedTransaction(
	tx: Prisma.TransactionClient,
	params: {
		hydraHeadId: string;
		txId: string;
		currentTransaction: {
			id: string;
			txHash: string | null;
			intendedTxHash: string | null;
			status: TransactionStatus;
			previousOnChainState: OnChainState | null;
			newOnChainState: OnChainState | null;
			BlocksWallet: { id: string } | null;
		} | null;
		previousState: OnChainState | null;
		newState: OnChainState;
	},
): Promise<string> {
	const { hydraHeadId, txId, currentTransaction, previousState, newState } = params;
	const canRepresentTransition = (candidate: {
		status: TransactionStatus;
		previousOnChainState: OnChainState | null;
		newOnChainState: OnChainState | null;
	}): boolean =>
		(candidate.previousOnChainState === previousState && candidate.newOnChainState === newState) ||
		(candidate.status === TransactionStatus.Pending &&
			candidate.previousOnChainState == null &&
			candidate.newOnChainState == null);
	if (
		(currentTransaction?.txHash === txId || currentTransaction?.intendedTxHash === txId) &&
		canRepresentTransition(currentTransaction)
	) {
		await tx.transaction.update({
			where: { id: currentTransaction.id },
			data: {
				txHash: txId,
				intendedTxHash: txId,
				status: TransactionStatus.Confirmed,
				layer: TransactionLayer.L2,
				HydraHead: { connect: { id: hydraHeadId } },
				previousOnChainState: previousState,
				newOnChainState: newState,
				...(currentTransaction.BlocksWallet ? { BlocksWallet: { disconnect: true } } : {}),
			},
		});
		return currentTransaction.id;
	}

	const existing = await tx.transaction.findFirst({
		where: {
			layer: TransactionLayer.L2,
			hydraHeadId,
			AND: [
				{ OR: [{ txHash: txId }, { txHash: null, intendedTxHash: txId }] },
				{
					OR: [
						{ previousOnChainState: previousState, newOnChainState: newState },
						{
							status: TransactionStatus.Pending,
							previousOnChainState: null,
							newOnChainState: null,
						},
					],
				},
			],
		},
		select: {
			id: true,
			status: true,
			previousOnChainState: true,
			newOnChainState: true,
			BlocksWallet: { select: { id: true } },
		},
	});
	if (existing && canRepresentTransition(existing)) {
		await tx.transaction.update({
			where: { id: existing.id },
			data: {
				txHash: txId,
				intendedTxHash: txId,
				status: TransactionStatus.Confirmed,
				layer: TransactionLayer.L2,
				HydraHead: { connect: { id: hydraHeadId } },
				previousOnChainState: previousState,
				newOnChainState: newState,
				...(existing.BlocksWallet ? { BlocksWallet: { disconnect: true } } : {}),
			},
		});
		if (existing.BlocksWallet) {
			// `lockPurpose` goes with the lock it describes. A marker left on an
			// unlocked wallet is adopted by the next holder — a batcher, which sets
			// only `lockedAt` — and the next `releaseHotWalletAfterL1` then frees
			// that batcher's lock inside its build window. Nothing today can reach
			// this write while a healthy Hydra L1 lock is held, so this preserves a
			// violating state rather than creating one; it is also the state
			// `unstickPurposeLocks` can no longer see, because `lockedAt` is fresh
			// rather than null or half an hour stale.
			await tx.hotWallet.update({
				where: { id: existing.BlocksWallet.id, deletedAt: null },
				data: { lockedAt: null, lockPurpose: null },
			});
		}
		return existing.id;
	}

	const created = await tx.transaction.create({
		data: {
			txHash: txId,
			status: TransactionStatus.Confirmed,
			layer: TransactionLayer.L2,
			HydraHead: { connect: { id: hydraHeadId } },
			previousOnChainState: previousState,
			newOnChainState: newState,
		},
		select: { id: true },
	});
	return created.id;
}

export async function releaseBlockedWallet(
	tx: Prisma.TransactionClient,
	currentTransaction: { id: string; BlocksWallet: { id: string } | null } | null,
): Promise<void> {
	if (!currentTransaction?.BlocksWallet) return;
	await tx.transaction.update({
		where: { id: currentTransaction.id },
		data: { BlocksWallet: { disconnect: true } },
	});
	// Cleared with the lock, for the reason given on the sibling write above.
	await tx.hotWallet.update({
		where: { id: currentTransaction.BlocksWallet.id, deletedAt: null },
		data: { lockedAt: null, lockPurpose: null },
	});
}
