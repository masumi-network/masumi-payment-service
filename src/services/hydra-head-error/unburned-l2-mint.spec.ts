/**
 * One HydraHeadError row per head for unburned-mint incidents.
 *
 * The node reports an open incident on every verified snapshot and replay
 * pass, and a peer that mints and burns in turn opens a new incident every
 * other snapshot. A plain write per report or per incident would grow the
 * table without limit, so each head keeps one row and checks the database at
 * most once per interval.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { HydraHeadStatus } from '@/generated/prisma/client';
import type { L2MintIncident } from '@/lib/hydra/hydra/l2-mint-tally';

type Row = {
	id: string;
	hydraHeadId: string;
	clientInput: string | null;
	txHash: string | null;
	errorMessage?: string;
};

const TEN_MINUTES_MS = 10 * 60 * 1000;

let rows: Row[];
let queries: number;
let failNextQuery: boolean;

function matches(row: Row, where: Partial<Row>): boolean {
	return Object.entries(where).every(([key, value]) => row[key as keyof Row] === value);
}

async function query(): Promise<void> {
	await Promise.resolve();
	queries += 1;
	if (failNextQuery) {
		failNextQuery = false;
		throw new Error('database unavailable');
	}
}

jest.unstable_mockModule('@masumi/payment-core/db', () => ({
	prisma: {
		hydraHeadError: {
			findMany: async ({ where }: { where: Partial<Row> }) => {
				await query();
				return rows.filter((row) => matches(row, where));
			},
			create: async ({ data }: { data: Omit<Row, 'id'> }) => {
				await query();
				const row = { ...data, id: `row-${rows.length}` };
				rows.push(row);
				return row;
			},
			updateMany: async ({ where, data }: { where: Partial<Row>; data: Partial<Row> }) => {
				await query();
				const matching = rows.filter((row) => matches(row, where));
				for (const row of matching) Object.assign(row, data);
				return { count: matching.length };
			},
		},
	},
}));

jest.unstable_mockModule('@masumi/payment-core/logger', () => ({
	logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

let recordUnburnedL2Mint: typeof import('./unburned-l2-mint').recordUnburnedL2Mint;

beforeAll(async () => {
	({ recordUnburnedL2Mint } = await import('./unburned-l2-mint'));
});

// The module keeps its per-head state across tests, so each test uses its own head id.
beforeEach(() => {
	jest.useFakeTimers({ doNotFake: ['nextTick', 'queueMicrotask'] });
	rows = [];
	queries = 0;
	failNextQuery = false;
});

afterEach(() => {
	jest.clearAllTimers();
	jest.useRealTimers();
});

function incident(txHash: string): L2MintIncident {
	return { txHash, snapshotNumber: 2, netUnits: { count: 1, sample: [`${'ab'.repeat(28)}61 +1`] } };
}

describe('recordUnburnedL2Mint', () => {
	it('writes one row and one round of queries for a burst of reports', async () => {
		const first = incident('11'.repeat(32));
		await Promise.all([
			recordUnburnedL2Mint('head-burst', HydraHeadStatus.Open, first),
			recordUnburnedL2Mint('head-burst', HydraHeadStatus.Open, first),
		]);
		await recordUnburnedL2Mint('head-burst', HydraHeadStatus.Open, first);

		expect(rows.map((row) => row.txHash)).toEqual([first.txHash]);
		expect(queries).toBe(2);
	});

	// A peer that mints and burns in turn opens a new incident every other
	// snapshot, and can then go quiet. The row follows the latest incident
	// without a later report; it does not multiply.
	it('moves the one row to the latest incident when the wait ends', async () => {
		for (let cycle = 0; cycle < 20; cycle += 1) {
			await recordUnburnedL2Mint('head-cycling', HydraHeadStatus.Open, incident(cycle.toString(16).padStart(64, '0')));
		}
		expect(rows).toHaveLength(1);
		expect(queries).toBe(2);

		await jest.advanceTimersByTimeAsync(TEN_MINUTES_MS);

		const latest = (19).toString(16).padStart(64, '0');
		expect(rows.map((row) => row.txHash)).toEqual([latest]);
		expect(rows[0].errorMessage).toContain(latest);
	});

	// A lease handover can leave two rows. Both must follow the incident.
	it('moves every row of the head to a new incident', async () => {
		const old = '66'.repeat(32);
		rows.push(
			{ id: 'owner-a', hydraHeadId: 'head-handover', clientInput: 'L2Mint', txHash: old },
			{ id: 'owner-b', hydraHeadId: 'head-handover', clientInput: 'L2Mint', txHash: old },
		);
		const next = incident('77'.repeat(32));

		await recordUnburnedL2Mint('head-handover', HydraHeadStatus.Open, next);

		expect(rows.map((row) => row.txHash)).toEqual([next.txHash, next.txHash]);
	});

	// A restart empties the in-process gate; the stored row must still count.
	it('does not repeat a row written before a restart', async () => {
		const known = incident('33'.repeat(32));
		rows.push({ id: 'old', hydraHeadId: 'head-restart', clientInput: 'L2Mint', txHash: known.txHash });

		await recordUnburnedL2Mint('head-restart', HydraHeadStatus.Open, known);

		expect(rows).toHaveLength(1);
	});

	// An operator can clear the head's errors while the head is still blocked.
	it('writes the row again when the wait ends', async () => {
		const open = incident('55'.repeat(32));
		await recordUnburnedL2Mint('head-cleared', HydraHeadStatus.Open, open);
		rows = [];

		await recordUnburnedL2Mint('head-cleared', HydraHeadStatus.Open, open);
		expect(rows).toHaveLength(0);
		await jest.advanceTimersByTimeAsync(TEN_MINUTES_MS);

		expect(rows.map((row) => row.txHash)).toEqual([open.txHash]);
	});

	// An outage must cost one query per head per retry interval, not one per
	// snapshot, and must not lose the record once the database is back.
	it('waits a short interval after a failed check, then writes the row', async () => {
		const pending = incident('44'.repeat(32));
		failNextQuery = true;

		await recordUnburnedL2Mint('head-retry', HydraHeadStatus.Open, pending);
		await recordUnburnedL2Mint('head-retry', HydraHeadStatus.Open, pending);
		expect(queries).toBe(1);
		expect(rows).toHaveLength(0);

		await jest.advanceTimersByTimeAsync(30 * 1000);

		expect(rows.map((row) => row.txHash)).toEqual([pending.txHash]);
	});

	// A report held while a check was running is older than any report that
	// starts the next check, so it must not be written after that one.
	it('drops a held report once a newer report is checked', async () => {
		const first = incident('88'.repeat(32));
		const held = incident('99'.repeat(32));
		const newest = incident('aa'.repeat(32));
		failNextQuery = true;
		const failing = recordUnburnedL2Mint('head-race', HydraHeadStatus.Open, first);
		await recordUnburnedL2Mint('head-race', HydraHeadStatus.Open, held);
		await failing;

		await jest.advanceTimersByTimeAsync(31 * 1000);
		await recordUnburnedL2Mint('head-race', HydraHeadStatus.Open, newest);
		await jest.advanceTimersByTimeAsync(3 * TEN_MINUTES_MS);

		expect(rows.map((row) => row.txHash)).toEqual([newest.txHash]);
	});
});
