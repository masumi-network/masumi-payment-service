/**
 * One HydraHeadError row per head for unburned-mint incidents.
 *
 * The node reports an open incident on every verified snapshot while its
 * replay is current and at the end of each complete pass, and a peer that
 * mints and burns in turn opens a new incident every other snapshot. A plain
 * write per report or per incident would grow the table without limit, so
 * each head keeps one row and, within one connection, checks the database at
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
let stallNextQuery: Promise<void> | undefined;
let afterNextRead: (() => void) | undefined;

function matches(row: Row, where: Partial<Row>): boolean {
	return Object.entries(where).every(([key, value]) => row[key as keyof Row] === value);
}

async function query(): Promise<void> {
	const stall = stallNextQuery;
	stallNextQuery = undefined;
	await (stall ?? Promise.resolve());
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
				const found = rows.filter((row) => matches(row, where));
				afterNextRead?.();
				afterNextRead = undefined;
				return found;
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
let dropUnburnedL2MintReports: typeof import('./unburned-l2-mint').dropUnburnedL2MintReports;

beforeAll(async () => {
	({ recordUnburnedL2Mint, dropUnburnedL2MintReports } = await import('./unburned-l2-mint'));
});

// The module keeps its per-head state across tests, so each test uses its own head id.
beforeEach(() => {
	jest.useFakeTimers({ doNotFake: ['nextTick', 'queueMicrotask'] });
	rows = [];
	queries = 0;
	failNextQuery = false;
	stallNextQuery = undefined;
	afterNextRead = undefined;
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

		await jest.advanceTimersByTimeAsync(TEN_MINUTES_MS - 1);
		expect(queries).toBe(2);
		await jest.advanceTimersByTimeAsync(1);

		const latest = (19).toString(16).padStart(64, '0');
		expect(rows.map((row) => row.txHash)).toEqual([latest]);
		expect(rows[0].errorMessage).toContain(latest);
	});

	// A lease handover can leave two rows, and the other owner may already have
	// moved one of them. Both must follow the incident.
	it('moves every row of the head to a new incident', async () => {
		const next = incident('77'.repeat(32));
		rows.push(
			{ id: 'owner-a', hydraHeadId: 'head-handover', clientInput: 'L2Mint', txHash: next.txHash },
			{ id: 'owner-b', hydraHeadId: 'head-handover', clientInput: 'L2Mint', txHash: '66'.repeat(32) },
		);

		await recordUnburnedL2Mint('head-handover', HydraHeadStatus.Open, next);

		expect(rows.map((row) => row.txHash)).toEqual([next.txHash, next.txHash]);
	});

	// A restart empties the in-process gate; the stored row must still count.
	it('does not repeat a row written before a restart', async () => {
		const known = incident('33'.repeat(32));
		rows.push({ id: 'old', hydraHeadId: 'head-restart', clientInput: 'L2Mint', txHash: known.txHash });

		await recordUnburnedL2Mint('head-restart', HydraHeadStatus.Open, known);

		expect(rows).toHaveLength(1);
		expect(queries).toBe(1);
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

	// A report that arrives during a failed check must wait for the retry
	// interval, not the full one, even if the head sends nothing after it.
	it('checks a report kept during a failed check after the retry interval', async () => {
		const first = incident('88'.repeat(32));
		const kept = incident('99'.repeat(32));
		failNextQuery = true;
		const failing = recordUnburnedL2Mint('head-failed-check', HydraHeadStatus.Open, first);
		await recordUnburnedL2Mint('head-failed-check', HydraHeadStatus.Open, kept);
		await failing;

		await jest.advanceTimersByTimeAsync(31 * 1000);

		expect(rows.map((row) => row.txHash)).toEqual([kept.txHash]);
	});

	// A database call can hang for longer than the interval. A second check
	// started meanwhile would finish first, and the stalled one would then
	// write its older incident over the newer row.
	it('runs one check at a time, so a stalled check cannot overwrite a newer row', async () => {
		let release!: () => void;
		stallNextQuery = new Promise((resolve) => {
			release = resolve;
		});
		const older = incident('bb'.repeat(32));
		const newer = incident('cc'.repeat(32));
		const stalled = recordUnburnedL2Mint('head-stall', HydraHeadStatus.Open, older);
		await recordUnburnedL2Mint('head-stall', HydraHeadStatus.Open, newer);

		await jest.advanceTimersByTimeAsync(TEN_MINUTES_MS);
		expect(rows).toHaveLength(0);
		release();
		await stalled;
		await jest.advanceTimersByTimeAsync(TEN_MINUTES_MS);

		expect(rows.map((row) => row.txHash)).toEqual([newer.txHash]);
	});

	// After a lease handover the new owner writes the row; the old process must
	// not move it back to the report it kept.
	it('writes nothing for a head after it is dropped', async () => {
		const current = incident('dd'.repeat(32));
		await recordUnburnedL2Mint('head-dropped', HydraHeadStatus.Open, current);
		await recordUnburnedL2Mint('head-dropped', HydraHeadStatus.Open, incident('ee'.repeat(32)));

		dropUnburnedL2MintReports('head-dropped');
		await jest.advanceTimersByTimeAsync(3 * TEN_MINUTES_MS);

		expect(rows.map((row) => row.txHash)).toEqual([current.txHash]);
	});

	it('creates the row when an operator clears it between the read and the write', async () => {
		rows.push({ id: 'old', hydraHeadId: 'head-cleared-mid', clientInput: 'L2Mint', txHash: '00'.repeat(32) });
		afterNextRead = () => {
			rows = [];
		};
		const next = incident('ab'.repeat(32));

		await recordUnburnedL2Mint('head-cleared-mid', HydraHeadStatus.Open, next);

		expect(rows.map((row) => row.txHash)).toEqual([next.txHash]);
	});
	// A check started by the timer must leave the head able to arm the next one.
	it('keeps checking after a check the timer started', async () => {
		await recordUnburnedL2Mint('head-timer', HydraHeadStatus.Open, incident('a1'.repeat(32)));
		await recordUnburnedL2Mint('head-timer', HydraHeadStatus.Open, incident('a2'.repeat(32)));
		await jest.advanceTimersByTimeAsync(TEN_MINUTES_MS);
		const latest = incident('a3'.repeat(32));
		await recordUnburnedL2Mint('head-timer', HydraHeadStatus.Open, latest);
		await jest.advanceTimersByTimeAsync(TEN_MINUTES_MS);

		expect(rows.map((row) => row.txHash)).toEqual([latest.txHash]);
	});

	// A head that sends nothing after a check costs no more queries.
	it('does not check the same report again', async () => {
		await recordUnburnedL2Mint('head-quiet', HydraHeadStatus.Open, incident('b1'.repeat(32)));
		const afterFirstCheck = queries;

		await jest.advanceTimersByTimeAsync(5 * TEN_MINUTES_MS);

		expect(queries).toBe(afterFirstCheck);
	});

	// A report kept while a check is running belongs to the stopped connection.
	it('drops a report kept during a check that is still running', async () => {
		let release!: () => void;
		stallNextQuery = new Promise((resolve) => {
			release = resolve;
		});
		const first = incident('c1'.repeat(32));
		const running = recordUnburnedL2Mint('head-drop-running', HydraHeadStatus.Open, first);
		await recordUnburnedL2Mint('head-drop-running', HydraHeadStatus.Open, incident('c2'.repeat(32)));

		dropUnburnedL2MintReports('head-drop-running');
		release();
		await running;
		await jest.advanceTimersByTimeAsync(3 * TEN_MINUTES_MS);

		expect(rows.map((row) => row.txHash)).toEqual([first.txHash]);
	});

	// A reconnect while the old connection's check is stalled must not start a
	// second check beside it: the older one would finish last.
	it('makes a reconnect wait for the check of the stopped connection', async () => {
		let release!: () => void;
		stallNextQuery = new Promise((resolve) => {
			release = resolve;
		});
		const older = incident('d1'.repeat(32));
		const newer = incident('d2'.repeat(32));
		const running = recordUnburnedL2Mint('head-reconnect', HydraHeadStatus.Open, older);
		dropUnburnedL2MintReports('head-reconnect');
		await recordUnburnedL2Mint('head-reconnect', HydraHeadStatus.Open, newer);

		release();
		await running;
		await jest.advanceTimersByTimeAsync(TEN_MINUTES_MS);

		expect(rows.map((row) => row.txHash)).toEqual([newer.txHash]);
	});
});
