import { HydraDecommitStatus } from '@/generated/prisma/client';

/**
 * What a withdrawal is refused with when something already holds what it needs.
 *
 * The executor decides these inside its slot claim, and the endpoint checks them
 * first, so the operator is told in the answer instead of after "accepted" in an
 * error list. Kept in one place so the two cannot word the same refusal
 * differently.
 */

export const WALLET_BUSY_MESSAGE =
	'This wallet is busy with another transaction, such as a pending payment or an earlier withdrawal; retry once it has settled';

/** A wallet a withdrawal can claim: not deleted, and not held by any other lock. */
export const claimableWalletWhere = {
	deletedAt: null,
	lockedAt: null,
	pendingTransactionId: null,
	lockPurpose: null,
} as const;

export function liveEscrowsRefusal(liveEscrows: number): string {
	return (
		`Cannot withdraw the collateral while escrows are still live or pending in this head (${liveEscrows} found). ` +
		'Without collateral they could not be settled, and closing the head would be the only way to recover them. ' +
		'Settle them first, or withdraw an amount instead.'
	);
}

export function activeWithdrawalRefusal(
	active: { id: string; status: HydraDecommitStatus; decommitTxId: string | null },
	askNode: boolean,
): string {
	if (active.status === HydraDecommitStatus.Approved) {
		return 'A prior withdrawal has left the head and is still settling on L1';
	}
	return askNode
		? `A prior withdrawal (${active.decommitTxId ?? active.id}) never settled, and the node did not ` +
				'confirm it holds no withdrawal, so it cannot be given up on yet; retry once the node answers'
		: 'A withdrawal from this head is already in progress';
}
