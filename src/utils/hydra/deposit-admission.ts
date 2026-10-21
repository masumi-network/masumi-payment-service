/**
 * The deposit side of the close admission.
 *
 * Close locks the head row, counts the work it would strand, and sets the
 * `isClosing` latch. A deposit that reaches L1 after that latch is not part of
 * the fanout, and Recover needs a live node session the close is about to end.
 * So both deposit paths (top-up and initial commit) take the same row lock
 * before they record work and before they submit. Whichever side commits first
 * is visible to the other: either close counts the deposit, or the deposit sees
 * the latch and stops.
 *
 * Call inside a Serializable transaction. A transaction that waits on this lock
 * keeps the snapshot it took before the wait, so only Serializable turns a write
 * it cannot see into a retryable conflict instead of a silent miss.
 *
 * A remote peer can still close the head on its own, so this does not replace
 * Recover. It only stops this service from racing its own close.
 */

import { HydraHeadStatus, Prisma } from '@/generated/prisma/client';
import createHttpError from 'http-errors';

export async function lockOpenHydraHeadForDeposit(tx: Prisma.TransactionClient, hydraHeadId: string): Promise<void> {
	const rows = await tx.$queryRaw<Array<{ status: HydraHeadStatus; isEnabled: boolean; isClosing: boolean }>>(
		Prisma.sql`
			SELECT "status", "isEnabled", "isClosing"
			FROM "HydraHead"
			WHERE "id" = ${hydraHeadId}
			FOR UPDATE
		`,
	);
	const head = rows[0];
	if (!head) throw createHttpError(404, 'Hydra head not found');
	if (!head.isEnabled) throw createHttpError(409, 'Cannot deposit into a disabled Hydra head');
	if (head.isClosing) throw createHttpError(409, 'Cannot deposit: Hydra head close is in progress');
	if (head.status !== HydraHeadStatus.Open) {
		throw createHttpError(409, `Cannot deposit: head status is ${head.status}, expected Open`);
	}
}
