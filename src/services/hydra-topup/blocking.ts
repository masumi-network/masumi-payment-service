import { HydraTopupStatus, type Prisma } from '@/generated/prisma/client';
import { logger } from '@masumi/payment-core/logger';
import { PREPARING_STALE_AFTER_MS } from './stale';

/**
 * The top-up that keeps a participant from starting another deposit, or null.
 *
 * Call it inside the serializable transaction that writes the new deposit row,
 * after `lockOpenHydraHeadForDeposit`. A caller may also run it first outside
 * one, to refuse before spending anything; only the locked call is binding.
 *
 * Pending and Confirmed rows always block: Confirmed is on L1 but has not
 * raised the in-head balance yet. Preparing also blocks, since it can hold a
 * carve on L1. A Preparing row older than `PREPARING_STALE_AFTER_MS` is failed
 * here instead, because nothing else can resolve one: it has no deposit hash
 * for reconciliation to look for.
 *
 * `ignoreCommits` skips commit display rows. The commit path refuses a second
 * commit on the participant's own commit columns, with an error that names the
 * pending commit rather than a top-up.
 */
export async function claimBlockingHydraTopup(
	tx: Prisma.TransactionClient,
	participantId: string,
	options: { ignoreCommits?: boolean } = {},
) {
	const scope = {
		hydraLocalParticipantId: participantId,
		...(options.ignoreCommits ? { isInitialCommit: false } : {}),
	};
	const deposit = await tx.hydraTopup.findFirst({
		where: { ...scope, status: { in: [HydraTopupStatus.Pending, HydraTopupStatus.Confirmed] } },
		orderBy: { createdAt: 'desc' },
	});
	if (deposit !== null) return deposit;
	const preparing = await tx.hydraTopup.findFirst({
		where: { ...scope, status: HydraTopupStatus.Preparing },
		orderBy: { createdAt: 'desc' },
	});
	if (preparing === null) return null;
	if (Date.now() - preparing.createdAt.getTime() <= PREPARING_STALE_AFTER_MS) return preparing;
	await tx.hydraTopup.updateMany({
		where: { id: preparing.id, status: HydraTopupStatus.Preparing },
		data: { status: HydraTopupStatus.Failed },
	});
	logger.warn(`[HydraAPI] Failed a stale preparing top-up ${preparing.id} so a new deposit can start`);
	return null;
}

/** The 409 message for a deposit refused by `claimBlockingHydraTopup`. */
export function blockingHydraTopupMessage(status: HydraTopupStatus): string {
	if (status === HydraTopupStatus.Preparing) return 'A prior Hydra top-up is still being prepared on L1';
	if (status === HydraTopupStatus.Pending) return 'A prior Hydra top-up remains pending independent L1 confirmation';
	return 'A prior Hydra top-up is confirmed on L1 but has not been absorbed or recovered';
}
