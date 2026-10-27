import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { parseHydraJson } from '@/lib/hydra/hydra/json';
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
	const findUnique = jest.fn(async (args: { where: { hydraHeadId: string } }) => {
		const row = rows.get(args.where.hydraHeadId);
		return row ? { snapshotNumber: row.snapshotNumber } : null;
	});
	const database = { hydraHeadSignedSnapshot: { updateMany, createMany, findUnique } } as unknown as Parameters<
		typeof createSignedSnapshotRecorder
	>[1];
	return { database, rows, writes, updateMany, createMany, findUnique };
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

	// Every reconnect replays the history from the start.
	it('writes nothing while a replay re-delivers snapshots already stored', async () => {
		const { database, rows, updateMany, createMany, findUnique } = createDatabase();
		rows.set(HEAD_ID, { hydraHeadId: HEAD_ID, snapshotNumber: 9n, snapshotVersion: 0n, confirmedSnapshot: 'x' });
		const record = createSignedSnapshotRecorder(HEAD_ID, database);

		for (let number = 1; number <= 9; number += 1) {
			record(payload(number));
			await settle();
		}

		expect(updateMany).not.toHaveBeenCalled();
		expect(createMany).not.toHaveBeenCalled();
		expect(findUnique).toHaveBeenCalledTimes(1);
		record(payload(10));
		await settle();
		expect(rows.get(HEAD_ID)?.snapshotNumber).toBe(10n);
	});

	it('learns a newer stored number instead of writing each older snapshot', async () => {
		const { database, rows, createMany, updateMany } = createDatabase();
		createMany.mockImplementationOnce(async () => {
			rows.set(HEAD_ID, { hydraHeadId: HEAD_ID, snapshotNumber: 9n, snapshotVersion: 0n, confirmedSnapshot: 'x' });
			return { count: 0 };
		});
		const record = createSignedSnapshotRecorder(HEAD_ID, database);

		record(payload(5));
		await settle();
		const callsAfterFirst = updateMany.mock.calls.length;
		record(payload(7));
		await settle();

		expect(updateMany).toHaveBeenCalledTimes(callsAfterFirst);
		expect(rows.get(HEAD_ID)?.snapshotNumber).toBe(9n);
	});

	// Parsed quantities are bigint; plain JSON.stringify throws on them.
	it('keeps every digit of a quantity above 2^53 - 1', async () => {
		const { database, rows } = createDatabase();
		const record = createSignedSnapshotRecorder(HEAD_ID, database);
		const lovelace = 18_446_744_073_709_551_615n;
		const withLargeOutput = {
			...payload(1),
			snapshot: { ...payload(1).snapshot, utxo: { [`${'1'.repeat(64)}#0`]: { value: { lovelace } } } },
		} as unknown as HydraConfirmedSnapshotPayload;

		record(withLargeOutput);
		await settle();

		const stored = rows.get(HEAD_ID)?.confirmedSnapshot ?? '';
		expect(stored).toContain('18446744073709551615');
		expect(parseHydraJson(stored)).toEqual(withLargeOutput);
	});

	it('stops for good once the head row is gone', async () => {
		jest.useFakeTimers();
		const { database, createMany } = createDatabase();
		createMany.mockRejectedValue(Object.assign(new Error('foreign key'), { code: 'P2003' }));
		const record = createSignedSnapshotRecorder(HEAD_ID, database);

		record(payload(1));
		await settle();
		jest.advanceTimersByTime(SIGNED_SNAPSHOT_RETRY_MS);
		record(payload(2));
		await settle();

		expect(createMany).toHaveBeenCalledTimes(1);
		expect(jest.getTimerCount()).toBe(0);
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

	it('retries when the first read of the stored number fails', async () => {
		jest.useFakeTimers();
		const { database, rows, findUnique } = createDatabase();
		rows.set(HEAD_ID, { hydraHeadId: HEAD_ID, snapshotNumber: 9n, snapshotVersion: 0n, confirmedSnapshot: 'x' });
		findUnique.mockRejectedValueOnce(new Error('database unavailable'));
		const record = createSignedSnapshotRecorder(HEAD_ID, database);

		record(payload(5));
		await settle();
		record(payload(11));
		jest.advanceTimersByTime(SIGNED_SNAPSHOT_RETRY_MS);
		await settle();

		expect(findUnique).toHaveBeenCalledTimes(2);
		expect(rows.get(HEAD_ID)?.snapshotNumber).toBe(11n);
	});

	it('drops a snapshot that cannot be serialized instead of retrying it', async () => {
		jest.useFakeTimers();
		const { database, rows } = createDatabase();
		const record = createSignedSnapshotRecorder(HEAD_ID, database);
		const cyclic = payload(3);
		(cyclic.snapshot.confirmed as unknown as object[]).push(cyclic);

		record(cyclic);
		await settle();

		expect(jest.getTimerCount()).toBe(0);
		record(payload(2));
		await settle();
		expect(rows.get(HEAD_ID)?.snapshotNumber).toBe(2n);
	});
});
