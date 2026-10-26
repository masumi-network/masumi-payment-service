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

function snapshotNumberOf(payload: HydraConfirmedSnapshotPayload): bigint {
	return BigInt(payload.snapshot.number);
}

/**
 * Store `payload` unless the stored snapshot is already as new. Every write is
 * conditioned on a lower stored number, so two instances or two nodes of one
 * head can never replace a newer snapshot with an older one.
 */
async function storeIfNewer(
	database: SignedSnapshotDatabase,
	hydraHeadId: string,
	payload: HydraConfirmedSnapshotPayload,
): Promise<void> {
	const snapshotNumber = snapshotNumberOf(payload);
	const data = {
		snapshotNumber,
		snapshotVersion: BigInt(payload.snapshot.version),
		confirmedSnapshot: stringifyHydraJson(payload),
	};
	const replaceOlder = () =>
		database.hydraHeadSignedSnapshot.updateMany({
			where: { hydraHeadId, snapshotNumber: { lt: snapshotNumber } },
			data,
		});
	if ((await replaceOlder()).count === 1) return;
	const created = await database.hydraHeadSignedSnapshot.createMany({
		data: [{ hydraHeadId, ...data }],
		skipDuplicates: true,
	});
	// Another writer created the row between our update and our create. Its
	// snapshot may be older than ours.
	if (created.count === 0) await replaceOlder();
}

/**
 * Returns the callback a HydraNode calls for each verified snapshot. It never
 * throws and never blocks replay: one write runs at a time, and only the newest
 * snapshot that arrives meanwhile is written next.
 */
export function createSignedSnapshotRecorder(
	hydraHeadId: string,
	database: SignedSnapshotDatabase = prisma,
	retryDelayMs = SIGNED_SNAPSHOT_RETRY_MS,
): (payload: HydraConfirmedSnapshotPayload) => void {
	let storedNumber = -1n;
	let pending: HydraConfirmedSnapshotPayload | null = null;
	let isWriting = false;
	let retryTimer: NodeJS.Timeout | null = null;

	const flush = async (): Promise<void> => {
		isWriting = true;
		while (pending) {
			const payload = pending;
			pending = null;
			try {
				await storeIfNewer(database, hydraHeadId, payload);
				storedNumber = snapshotNumberOf(payload);
			} catch (error) {
				logger.warn('[HydraSignedSnapshot] could not store the signed snapshot', {
					hydraHeadId,
					snapshotNumber: payload.snapshot.number,
					error: error instanceof Error ? error.message : 'Unknown error',
				});
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
		const snapshotNumber = snapshotNumberOf(payload);
		if (snapshotNumber <= storedNumber) return;
		if (pending && snapshotNumber <= snapshotNumberOf(pending)) return;
		pending = payload;
		if (!isWriting && !retryTimer) void flush();
	};
}
