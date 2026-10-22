/**
 * The redeemer's record of a redemption, and the only ways it may change.
 *
 * Every write here names the role and the status it expects. The resume job and
 * a retrying request read a row and then act on it some time later, so each
 * write must find the row exactly as it was read, or change nothing: a late
 * writer must never reopen a finished redemption or finish a failed one.
 */
import createHttpError from 'http-errors';
import { HydraInviteRole, HydraInviteStatus, type Prisma } from '@/generated/prisma/client';
import { prisma } from '@masumi/payment-core/db';
import { isUniqueConstraintError } from '@masumi/payment-core/db-retry';

/** The statuses in which a redemption is still owed. Both shield the reservation, see `release-reservation.ts`. */
export const LIVE_REDEEMER_STATUSES = [HydraInviteStatus.Redeemed, HydraInviteStatus.Started] as const;

/**
 * Record the intent. `created: false` means a concurrent request recorded the
 * same nonce first, and the caller should resume that record instead.
 * `updatedAt` is the version the creator owns: a retry's claim moves it on.
 */
export async function createRedeemerRecord(
	data: Prisma.HydraHeadInviteCreateInput,
): Promise<{ created: true; id: string; updatedAt: Date } | { created: false }> {
	try {
		const row = await prisma.hydraHeadInvite.create({ data, select: { id: true, updatedAt: true } });
		return { created: true, id: row.id, updatedAt: row.updatedAt };
	} catch (error) {
		if (isUniqueConstraintError(error)) return { created: false };
		throw error;
	}
}

/**
 * Note that the issuer's Host took the redemption. True also when a concurrent
 * caller already did, since the outcome the caller wants is the same.
 */
export async function markAcknowledged(id: string): Promise<boolean> {
	const stamped = await prisma.hydraHeadInvite.updateMany({
		where: { id, role: HydraInviteRole.Redeemer, status: HydraInviteStatus.Redeemed, redeemedAt: null },
		data: { redeemedAt: new Date() },
	});
	if (stamped.count === 1) return true;
	const current = await prisma.hydraHeadInvite.findUnique({
		where: { id },
		select: { status: true, redeemedAt: true },
	});
	return (
		current !== null &&
		current.redeemedAt !== null &&
		(current.status === HydraInviteStatus.Redeemed ||
			current.status === HydraInviteStatus.Started ||
			current.status === HydraInviteStatus.Completed)
	);
}

/** Our node has its peers and was started. False means it had already moved on, which is fine. */
export async function markStarted(id: string): Promise<boolean> {
	const moved = await prisma.hydraHeadInvite.updateMany({
		where: { id, role: HydraInviteRole.Redeemer, status: HydraInviteStatus.Redeemed, redeemedAt: { not: null } },
		data: { status: HydraInviteStatus.Started },
	});
	return moved.count === 1;
}

/**
 * Take hold of an unconfirmed record before posting it again, by moving
 * `updatedAt` on from the value this caller read.
 *
 * A record is deleted or failed only against the `updatedAt` its writer last
 * saw. So a request that did not create the record claims it first, and the
 * creator's refusal, which would otherwise delete a record this retry is about
 * to acknowledge, finds it changed and leaves it. `next` must be later than
 * `expectedUpdatedAt` or the claim would invalidate nothing.
 */
export async function claimUnconfirmed(id: string, expectedUpdatedAt: Date, next: Date): Promise<boolean> {
	const claimed = await prisma.hydraHeadInvite.updateMany({
		where: {
			id,
			role: HydraInviteRole.Redeemer,
			status: HydraInviteStatus.Redeemed,
			redeemedAt: null,
			updatedAt: expectedUpdatedAt,
		},
		data: { updatedAt: next },
	});
	return claimed.count === 1;
}

/**
 * Delete a record whose redemption provably never landed, so the same invite
 * code can be tried again. It cannot touch a record the issuer acknowledged, one
 * that already has a head, or one a retry has claimed since `expectedUpdatedAt`.
 */
export async function discardUnlanded(id: string, expectedUpdatedAt: Date): Promise<void> {
	await prisma.hydraHeadInvite.deleteMany({
		where: {
			id,
			role: HydraInviteRole.Redeemer,
			status: HydraInviteStatus.Redeemed,
			redeemedAt: null,
			hydraHeadId: null,
			updatedAt: expectedUpdatedAt,
		},
	});
}

/** End a redemption whose nonce is provably someone else's. Never an acknowledged or a newly claimed one. */
export async function failUnconfirmed(id: string, expectedUpdatedAt: Date): Promise<boolean> {
	const failed = await prisma.hydraHeadInvite.updateMany({
		where: {
			id,
			role: HydraInviteRole.Redeemer,
			status: HydraInviteStatus.Redeemed,
			redeemedAt: null,
			updatedAt: expectedUpdatedAt,
		},
		data: { status: HydraInviteStatus.Failed },
	});
	return failed.count === 1;
}

/**
 * Complete the record and point it at its head. Runs in the head's transaction,
 * so a lost race throws and rolls the head back with it.
 */
export async function linkRedeemerToHead(db: Prisma.TransactionClient, id: string, hydraHeadId: string): Promise<void> {
	const linked = await db.hydraHeadInvite.updateMany({
		where: {
			id,
			role: HydraInviteRole.Redeemer,
			status: { in: [...LIVE_REDEEMER_STATUSES] },
			redeemedAt: { not: null },
			hydraHeadId: null,
		},
		data: { status: HydraInviteStatus.Completed, hydraHeadId },
	});
	if (linked.count !== 1) {
		throw createHttpError(409, 'the invite was adopted or discarded concurrently');
	}
}
