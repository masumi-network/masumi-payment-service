/**
 * Reading, and on an admin's decision resetting, a stuck snapshot round.
 *
 * The reset side-loads the node's OWN latest confirmed snapshot (Hydra's
 * documented recovery for a stuck head). That snapshot is already signed by
 * every party, so nothing new enters the head: the node only discards the round
 * in flight and its unconfirmed local transactions, which a round that can never
 * complete would never have confirmed anyway. hydra-host's `unwedge` does the
 * same after an undrained restart; this is the live, operator-approved path.
 *
 * Every precondition is re-checked here, against live node state, because the
 * request only carries what the admin saw:
 * - the session for this head is held by this instance (the ownership fence);
 * - the round in flight is the exact round the admin approved (no stale UI);
 * - that round has been recorded unchanged for the stuck threshold;
 * - the body posted is the node's own `GET /snapshot`, never client input, and
 *   it is the pinned head's snapshot at the number this service verified.
 */
import createHttpError from 'http-errors';
import { HydraHeadStatus } from '@/generated/prisma/client';
import { prisma } from '@masumi/payment-core/db';
import { logger } from '@masumi/payment-core/logger';
import { HydraTransportAmbiguousError } from '@/lib/hydra';
import { fetchHydraSnapshotRound, type HydraSnapshotRound } from '@/lib/hydra/hydra/node-control-queries';
import { hydraConfirmedSnapshotSchema } from '@/lib/hydra/hydra/schemas';
import type { HydraNode } from '@/lib/hydra/hydra/node';
import { getHydraConnectionManager } from '@/services/hydra-connection-manager/hydra-connection-manager.service';
import { isSnapshotRoundStuck } from './watch';

export type SnapshotRoundStatus = {
	headId: string;
	inFlight: boolean;
	tag: string;
	snapshotNumber: number | null;
	signatoryCount: number;
	txIds: string[];
	/** Identifies the round; a reset must echo it back. */
	signature: string;
	/** When this exact round was first recorded, if it has been. */
	since: Date | null;
	stuck: boolean;
};

export type ResetSnapshotRoundResult = {
	headId: string;
	/** The confirmed snapshot the node was reset to. */
	confirmedSnapshotNumber: number;
	/** Unconfirmed transactions the reset discarded. */
	droppedTxIds: string[];
	/** The node's round after the reset; null when it could not be read back. */
	roundAfter: { tag: string; snapshotNumber: number | null } | null;
};

/** One reset per head at a time in this process; the session fence covers other instances. */
const resetsInFlight = new Set<string>();

const headSelect = {
	id: true,
	isEnabled: true,
	isClosing: true,
	ownerEpoch: true,
	status: true,
	headIdentifier: true,
	snapshotRoundSignature: true,
	snapshotRoundSince: true,
	LocalParticipant: { select: { id: true } },
} as const;

type HeadRow = {
	id: string;
	isEnabled: boolean;
	isClosing: boolean;
	ownerEpoch: bigint;
	status: HydraHeadStatus;
	headIdentifier: string | null;
	snapshotRoundSignature: string | null;
	snapshotRoundSince: Date | null;
	LocalParticipant: { id: string } | null;
};

async function loadOwnedHead(headId: string): Promise<{ head: HeadRow; node: HydraNode }> {
	const head = await prisma.hydraHead.findUnique({
		where: { id: headId },
		select: headSelect,
	});
	if (!head) throw createHttpError(404, 'Hydra head not found');
	if (!head.LocalParticipant) throw createHttpError(400, 'Head has no local participant');
	if (head.status !== HydraHeadStatus.Open) {
		throw createHttpError(409, `Head status is ${head.status}, expected Open`);
	}
	const node = getHydraConnectionManager().getNode(head.id);
	if (!node) throw createHttpError(502, 'No active connection to Hydra head');
	return { head, node };
}

async function readRound(node: HydraNode): Promise<HydraSnapshotRound> {
	try {
		return await fetchHydraSnapshotRound(node);
	} catch (error) {
		logger.warn('[HydraSnapshotRound] could not read the snapshot round', {
			error: error instanceof Error ? error.message : 'Unknown error',
		});
		throw createHttpError(502, 'Could not read the snapshot round from the Hydra node');
	}
}

function toStatus(head: HeadRow, round: HydraSnapshotRound, now: Date): SnapshotRoundStatus {
	// The recorded clock only belongs to this round when the signatures match.
	const since = round.inFlight && head.snapshotRoundSignature === round.signature ? head.snapshotRoundSince : null;
	return {
		headId: head.id,
		inFlight: round.inFlight,
		tag: round.tag,
		snapshotNumber: round.number,
		signatoryCount: round.signatoryCount,
		txIds: round.txIds,
		signature: round.signature,
		since,
		// A round without a number cannot be shown to be ahead of the confirmed
		// snapshot, so it is never offered for a reset. The watch still alerts on it.
		stuck: round.number !== null && isSnapshotRoundStuck(since, now),
	};
}

/**
 * The checks above awaited the node twice. Before the side-load, confirm this
 * instance still holds the same session, the service still verifies the same
 * snapshot, and no other attachment or close started meanwhile.
 */
async function assertStillOwned(
	head: HeadRow,
	node: HydraNode,
	verifiedNumber: bigint,
	roundSignature: string,
): Promise<void> {
	// The round can complete while the confirmed snapshot is read; a reset then
	// would side-load a snapshot older than the one just confirmed.
	const roundNow = await readRound(node);
	const current = await prisma.hydraHead.findUnique({ where: { id: head.id }, select: headSelect });
	if (
		getHydraConnectionManager().getNode(head.id) !== node ||
		node.verifiedSnapshotNumber !== verifiedNumber ||
		!roundNow.inFlight ||
		roundNow.signature !== roundSignature ||
		current == null ||
		current.status !== HydraHeadStatus.Open ||
		!current.isEnabled ||
		current.isClosing ||
		current.ownerEpoch !== head.ownerEpoch
	) {
		throw createHttpError(409, 'The head changed while the reset was checked; reload and review it again');
	}
}

export async function getSnapshotRoundStatus(headId: string): Promise<SnapshotRoundStatus> {
	const { head, node } = await loadOwnedHead(headId);
	return toStatus(head, await readRound(node), new Date());
}

export async function resetSnapshotRound(params: {
	headId: string;
	expectedSignature: string;
	actorApiKeyId: string;
}): Promise<ResetSnapshotRoundResult> {
	const { headId, expectedSignature, actorApiKeyId } = params;
	if (resetsInFlight.has(headId)) throw createHttpError(409, 'A reset of this head is already running');
	resetsInFlight.add(headId);
	try {
		const { head, node } = await loadOwnedHead(headId);
		if (!head.isEnabled) throw createHttpError(409, 'Cannot reset a round in a disabled Hydra head');
		if (head.isClosing) throw createHttpError(409, 'Cannot reset a round in a Hydra head that is closing');

		const round = await readRound(node);
		if (!round.inFlight) throw createHttpError(409, 'No snapshot round is in flight; nothing to reset');
		// An unknown tag counts as in flight for the watch, but without a number
		// nothing shows the round is ahead of the confirmed snapshot.
		if (round.number === null) throw createHttpError(409, `Cannot reset a ${round.tag} round that names no snapshot`);
		if (round.signature !== expectedSignature) {
			throw createHttpError(409, 'The snapshot round changed since it was shown; reload and review it again');
		}
		const status = toStatus(head, round, new Date());
		if (!status.stuck) {
			throw createHttpError(409, 'This round has not been stuck long enough to reset; it may still complete');
		}

		const verifiedNumber = node.verifiedSnapshotNumber;
		if (verifiedNumber === undefined) {
			throw createHttpError(409, 'The service has not verified the head’s confirmed snapshot yet; retry shortly');
		}
		let confirmed: unknown;
		try {
			confirmed = await node.get('/snapshot');
		} catch {
			throw createHttpError(502, 'Could not read the confirmed snapshot from the Hydra node');
		}
		const parsed = hydraConfirmedSnapshotSchema.safeParse(confirmed);
		if (!parsed.success || parsed.data.tag !== 'ConfirmedSnapshot') {
			throw createHttpError(409, 'The node has no signed snapshot to reset to');
		}
		const snapshot = parsed.data.snapshot;
		const pinnedHeadId = node.expectedHeadId ?? head.headIdentifier;
		if (pinnedHeadId == null || snapshot.headId !== pinnedHeadId) {
			throw createHttpError(409, 'The node’s confirmed snapshot is not for this head');
		}
		if (BigInt(snapshot.number) !== verifiedNumber) {
			throw createHttpError(
				409,
				`The node’s confirmed snapshot ${snapshot.number} differs from the verified snapshot ${verifiedNumber}; retry shortly`,
			);
		}
		if (round.number <= snapshot.number) {
			throw createHttpError(409, 'The round in flight is not newer than the confirmed snapshot');
		}

		await assertStillOwned(head, node, verifiedNumber, round.signature);

		logger.warn('[HydraSnapshotRound] admin is resetting a stuck snapshot round', {
			hydraHeadId: head.id,
			actorApiKeyId,
			roundTag: round.tag,
			roundNumber: round.number,
			signatoryCount: round.signatoryCount,
			droppedTxIds: round.txIds,
			stuckSince: status.since?.toISOString(),
			confirmedSnapshotNumber: snapshot.number,
		});
		try {
			await node.post('/snapshot', confirmed);
		} catch (error) {
			if (error instanceof HydraTransportAmbiguousError) {
				throw createHttpError(504, 'The node did not answer the reset; check the round before retrying');
			}
			logger.warn('[HydraSnapshotRound] node refused the reset', {
				hydraHeadId: head.id,
				error: error instanceof Error ? error.message : 'Unknown error',
			});
			throw createHttpError(502, 'The Hydra node refused the reset');
		}

		// The node can answer 202 when its own timeout runs out, which the client
		// cannot tell from success. So the recorded round is cleared only once the
		// read-back shows it moved; otherwise it stays, and the admin can retry
		// at once. A failed read-back is reported, not thrown, and the watch
		// clears the record when it next sees the node idle.
		const after = await fetchHydraSnapshotRound(node).catch(() => null);
		if (after?.inFlight && after.signature === round.signature) {
			// Also what a peer that proposes the round again looks like. Retrying here
			// then only drops our unconfirmed transactions again.
			throw createHttpError(
				502,
				'Our node is in the same round after the reset. The other party may have proposed it again; reset their node before retrying.',
			);
		}
		if (after) {
			// Conditioned on the round it reset, so a newer observation is never wiped.
			await prisma.hydraHead.updateMany({
				where: { id: head.id, snapshotRoundSignature: round.signature },
				data: { snapshotRoundSignature: null, snapshotRoundSince: null, snapshotRoundAlertedAt: null },
			});
		}
		logger.warn('[HydraSnapshotRound] stuck snapshot round reset', {
			hydraHeadId: head.id,
			actorApiKeyId,
			confirmedSnapshotNumber: snapshot.number,
			roundAfterTag: after?.tag ?? null,
		});
		return {
			headId: head.id,
			confirmedSnapshotNumber: snapshot.number,
			droppedTxIds: round.txIds,
			roundAfter: after ? { tag: after.tag, snapshotNumber: after.number } : null,
		};
	} finally {
		resetsInFlight.delete(headId);
	}
}
