import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { HydraConfirmedSnapshotPayload } from '@/lib/hydra/hydra/signed-snapshot';

const mockWarn = jest.fn();
jest.unstable_mockModule('@masumi/payment-core/logger', () => ({
	logger: { debug: jest.fn(), info: jest.fn(), warn: mockWarn, error: jest.fn() },
}));
jest.unstable_mockModule('@masumi/payment-core/db', () => ({ prisma: {} }));

const { createSignedSnapshotRecorder, SIGNED_SNAPSHOT_RETRY_MS } = await import('./recorder');

const HEAD_ID = 'head-1';

type Row = { hydraHeadId: string; snapshotNumber: bigint; snapshotVersion: bigint; confirmedSnapshot: string };
type RowData = Omit<Row, 'hydraHeadId'>;

/** Postgres semantics for the two writes the recorder makes, one row per head. */
function createDatabase() {
	const rows = new Map<string, Row>();
	const writes: bigint[] = [];
	const updateMany = jest.fn(
		async (args: { where: { hydraHeadId: string; snapshotNumber: { lt: bigint } }; data: RowData }) => {
			const row = rows.get(args.where.hydraHeadId);
			if (!row || row.snapshotNumber >= args.where.snapshotNumber.lt) return { count: 0 };
			rows.set(row.hydraHeadId, { ...row, ...args.data });
			writes.push(args.data.snapshotNumber);
			return { count: 1 };
		},
	);
	const createMany = jest.fn(async (args: { data: Row[]; skipDuplicates: boolean }) => {
		const [row] = args.data;
		if (rows.has(row.hydraHeadId)) return { count: 0 };
		rows.set(row.hydraHeadId, row);
		writes.push(row.snapshotNumber);
		return { count: 1 };
	});
	const database = { hydraHeadSignedSnapshot: { updateMany, createMany } } as unknown as Parameters<
		typeof createSignedSnapshotRecorder
	>[1];
	return { database, rows, writes, updateMany, createMany };
}

function payload(number: number): HydraConfirmedSnapshotPayload {
	return {
		tag: 'ConfirmedSnapshot',
		snapshot: {
			headId: 'a'.repeat(56),
			version: 0,
			number,
			accumulator: '0'.repeat(64),
			confirmed: [],
			utxo: {},
			utxoToCommit: null,
			utxoToDecommit: null,
		},
		signatures: { multiSignature: ['1'.repeat(128)] },
	};
}

/** Let every queued write settle. */
async function settle(): Promise<void> {
	for (let index = 0; index < 20; index += 1) await Promise.resolve();
}

describe('createSignedSnapshotRecorder', () => {
	beforeEach(() => {
		mockWarn.mockClear();
	});
	afterEach(() => {
		jest.useRealTimers();
	});

	it('keeps only the newest snapshot and never goes back', async () => {
		const { database, rows } = createDatabase();
		const record = createSignedSnapshotRecorder(HEAD_ID, database);

		record(payload(3));
		await settle();
		record(payload(5));
		await settle();
		record(payload(4));
		await settle();

		expect(rows.get(HEAD_ID)?.snapshotNumber).toBe(5n);
		expect(JSON.parse(rows.get(HEAD_ID)?.confirmedSnapshot ?? 'null')).toEqual(payload(5));
	});

	it('writes only the newest snapshot that arrived during a write', async () => {
		const { database, writes } = createDatabase();
		const record = createSignedSnapshotRecorder(HEAD_ID, database);

		record(payload(1));
		record(payload(2));
		record(payload(4));
		record(payload(3));
		await settle();

		expect(writes).toEqual([1n, 4n]);
	});

	it('does not replace a newer snapshot another instance stored', async () => {
		const { database, rows } = createDatabase();
		rows.set(HEAD_ID, { hydraHeadId: HEAD_ID, snapshotNumber: 9n, snapshotVersion: 0n, confirmedSnapshot: 'x' });
		const record = createSignedSnapshotRecorder(HEAD_ID, database);

		record(payload(5));
		await settle();

		expect(rows.get(HEAD_ID)).toEqual(expect.objectContaining({ snapshotNumber: 9n, confirmedSnapshot: 'x' }));
	});

	it('replaces an older row another writer created between our update and create', async () => {
		const { database, rows, createMany } = createDatabase();
		createMany.mockImplementationOnce(async () => {
			rows.set(HEAD_ID, { hydraHeadId: HEAD_ID, snapshotNumber: 2n, snapshotVersion: 0n, confirmedSnapshot: 'x' });
			return { count: 0 };
		});
		const record = createSignedSnapshotRecorder(HEAD_ID, database);

		record(payload(5));
		await settle();

		expect(rows.get(HEAD_ID)?.snapshotNumber).toBe(5n);
	});

	it('retries the failed snapshot when nothing newer arrives', async () => {
		jest.useFakeTimers();
		const { database, rows, updateMany } = createDatabase();
		updateMany.mockRejectedValueOnce(new Error('database unavailable'));
		const record = createSignedSnapshotRecorder(HEAD_ID, database);

		record(payload(3));
		await settle();
		jest.advanceTimersByTime(SIGNED_SNAPSHOT_RETRY_MS);
		await settle();

		expect(rows.get(HEAD_ID)?.snapshotNumber).toBe(3n);
	});

	it('retries a failed write later with the newest snapshot seen by then', async () => {
		jest.useFakeTimers();
		const { database, rows, updateMany } = createDatabase();
		updateMany.mockRejectedValueOnce(new Error('database unavailable'));
		const record = createSignedSnapshotRecorder(HEAD_ID, database);

		expect(() => record(payload(3))).not.toThrow();
		await settle();
		expect(mockWarn).toHaveBeenCalledTimes(1);
		record(payload(6));
		await settle();
		expect(rows.has(HEAD_ID)).toBe(false);

		jest.advanceTimersByTime(SIGNED_SNAPSHOT_RETRY_MS);
		await settle();

		expect(rows.get(HEAD_ID)?.snapshotNumber).toBe(6n);
	});
});
