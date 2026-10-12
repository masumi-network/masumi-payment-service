import { GuardedHydraTransferDirection, GuardedHydraTransferStatus } from '@/generated/prisma/client';
import { prisma } from '@masumi/payment-core/db';
import { DEPOSIT_L1_GRACE_MS, WITHDRAW_SETTLE_TIMEOUT_MS } from '../../../smart-wallet/hydra-transfer';

/**
 * A move of the guarded wallet that can still take effect. It names the current
 * wallet UTxO, so a purchase that spends that UTxO now would void it; purchases
 * wait instead.
 *
 * Same limits as the status read, which may not run for a while: a submitted
 * withdraw counts only for the UTxO the head still holds and only until the
 * settle timeout; a submitted deposit only until its L1 grace ends.
 */
export async function hasOpenGuardedMove(
	guarded: { id: string; heldWalletUtxoRef?: string },
	direction: GuardedHydraTransferDirection,
	now = new Date(),
): Promise<boolean> {
	const submitted =
		direction === GuardedHydraTransferDirection.Withdraw
			? {
					status: GuardedHydraTransferStatus.Submitted,
					walletUtxoRef: guarded.heldWalletUtxoRef,
					submittedAt: { gt: new Date(now.getTime() - WITHDRAW_SETTLE_TIMEOUT_MS) },
				}
			: {
					status: GuardedHydraTransferStatus.Submitted,
					OR: [{ signBefore: null }, { signBefore: { gt: new Date(now.getTime() - DEPOSIT_L1_GRACE_MS) } }],
				};
	const open = await prisma.guardedHydraTransfer.findFirst({
		where: {
			guardedWalletId: guarded.id,
			direction,
			OR: [
				submitted,
				{ status: GuardedHydraTransferStatus.Prepared, OR: [{ signBefore: null }, { signBefore: { gt: now } }] },
			],
		},
		select: { id: true },
	});
	return open != null;
}
