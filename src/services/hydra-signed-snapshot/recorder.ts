/**
 * Durable copy of the newest snapshot every head party signed.
 *
 * hydra-node contests a stale close only while it still holds the newer signed
 * snapshot. If its persistence is lost, so is that evidence. History replay
 * verifies each snapshot's party signatures, and this keeps the newest one in
 * the payment database, outside the node.
 */
import { prisma } from '@masumi/payment-core/db';
import { logger } from '@masumi/payment-core/logger';
import { stringifyHydraJson } from '@/lib/hydra/hydra/json';
import type { HydraConfirmedSnapshotPayload } from '@/lib/hydra/hydra/signed-snapshot';

/** A failed write is tried again after this delay, with the newest snapshot seen by then. */
export const SIGNED_SNAPSHOT_RETRY_MS = 30_000;

type SignedSnapshotDatabase = Pick<typeof prisma, 'hydraHeadSignedSnapshot'>;

/** No row yet: every snapshot number is higher. */
const NO_STORED_SNAPSHOT = -1n;

/** Prisma's foreign-key violation: the head row is gone, so no write can succeed. */
const PRISMA_FOREIGN_KEY_VIOLATION = 'P2003';

type SignedSnapshotRow = { snapshotNumber: bigint; snapshotVersion: bigint; confirmedSnapshot: string };

function snapshotNumberOf(payload: HydraConfirmedSnapshotPayload): bigint {
	return BigInt(payload.snapshot.number);
}

function toRow(payload: HydraConfirmedSnapshotPayload): SignedSnapshotRow {
	return {
		snapshotNumber: snapshotNumberOf(payload),
		snapshotVersion: BigInt(payload.snapshot.version),
		confirmedSnapshot: stringifyHydraJson(payload),
	};
}

async function readStoredNumber(database: SignedSnapshotDatabase, hydraHeadId: string): Promise<bigint> {
	const row = await database.hydraHeadSignedSnapshot.findUnique({
		where: { hydraHeadId },
		select: { snapshotNumber: true },
	});
	return row?.snapshotNumber ?? NO_STORED_SNAPSHOT;
}

/**
 * Store `data` unless the stored snapshot is already as new, and return the
 * stored number. Every write is conditioned on a lower stored number, so two
 * instances or two nodes of one head can never replace a newer snapshot with
 * an older one.
 */
async function storeIfNewer(
	database: SignedSnapshotDatabase,
	hydraHeadId: string,
	data: SignedSnapshotRow,
): Promise<bigint> {
	const { snapshotNumber } = data;
	const replaceOlder = () =>
		database.hydraHeadSignedSnapshot.updateMany({
			where: { hydraHeadId, snapshotNumber: { lt: snapshotNumber } },
			data,
		});
	if ((await replaceOlder()).count === 1) return snapshotNumber;
	const created = await database.hydraHeadSignedSnapshot.createMany({
		data: [{ hydraHeadId, ...data }],
		skipDuplicates: true,
	});
	if (created.count === 1) return snapshotNumber;
	// Another writer created the row between our update and our create. Its
	// snapshot may be older than ours.
	if ((await replaceOlder()).count === 1) return snapshotNumber;
	// Another writer stored a newer snapshot. Learn its number, so the rest of a
	// replay does not write each older snapshot again.
	return readStoredNumber(database, hydraHeadId);
}

/**
 * Returns the callback a HydraNode calls for each verified snapshot. It never
 * throws and never blocks replay: one write runs at a time, and only the newest
 * snapshot that arrives meanwhile is written next. A replay re-delivers every
 * snapshot from the start, so the stored number is read before the first write
 * and anything at or below it is skipped.
 */
export function createSignedSnapshotRecorder(
	hydraHeadId: string,
	database: SignedSnapshotDatabase = prisma,
	retryDelayMs = SIGNED_SNAPSHOT_RETRY_MS,
): (payload: HydraConfirmedSnapshotPayload) => void {
	let storedNumber: bigint | null = null;
	let pending: HydraConfirmedSnapshotPayload | null = null;
	let isWriting = false;
	let retryTimer: NodeJS.Timeout | null = null;
	let isHeadDeleted = false;

	const flush = async (): Promise<void> => {
		isWriting = true;
		while (pending) {
			const payload = pending;
			pending = null;
			let row: SignedSnapshotRow;
			try {
				row = toRow(payload);
			} catch (error) {
				// No retry can fix a payload that does not serialize. Drop it, so it
				// does not hold back the next one.
				logger.warn('[HydraSignedSnapshot] dropped a signed snapshot that cannot be serialized', {
					hydraHeadId,
					snapshotNumber: payload.snapshot.number,
					error: error instanceof Error ? error.message : 'Unknown error',
				});
				continue;
			}
			try {
				storedNumber ??= await readStoredNumber(database, hydraHeadId);
				if (row.snapshotNumber <= storedNumber) continue;
				storedNumber = await storeIfNewer(database, hydraHeadId, row);
			} catch (error) {
				const isHeadGone = (error as { code?: string } | null)?.code === PRISMA_FOREIGN_KEY_VIOLATION;
				logger.warn('[HydraSignedSnapshot] could not store the signed snapshot', {
					hydraHeadId,
					snapshotNumber: payload.snapshot.number,
					isHeadGone,
					error: error instanceof Error ? error.message : 'Unknown error',
				});
				if (isHeadGone) {
					isHeadDeleted = true;
					pending = null;
					break;
				}
				const newer: HydraConfirmedSnapshotPayload | null = pending;
				if (newer === null || snapshotNumberOf(newer) < snapshotNumberOf(payload)) pending = payload;
				retryTimer = setTimeout(() => {
					retryTimer = null;
					void flush();
				}, retryDelayMs);
				retryTimer.unref();
				break;
			}
		}
		isWriting = false;
	};

	return (payload) => {
		if (isHeadDeleted) return;
		const snapshotNumber = snapshotNumberOf(payload);
		if (storedNumber !== null && snapshotNumber <= storedNumber) return;
		if (pending && snapshotNumber <= snapshotNumberOf(pending)) return;
		pending = payload;
		if (!isWriting && !retryTimer) void flush();
	};
}
