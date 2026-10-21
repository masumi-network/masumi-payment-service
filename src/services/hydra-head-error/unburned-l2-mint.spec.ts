/**
 * One HydraHeadError row per unburned-mint incident.
 *
 * The node reports an open incident on every history replay pass, and a pass
 * runs on every reconnect. A plain write per report would add a row each time
 * the socket drops, so the record is keyed by the incident's minting tx.
 */

import { beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { HydraHeadStatus } from '@/generated/prisma/client';
import type { L2MintIncident } from '@/lib/hydra/hydra/l2-mint-tally';

type Row = { hydraHeadId: string; clientInput: string | null; txHash: string | null; errorMessage: string };

let rows: Row[];
let failNextCreate: boolean;

function matches(row: Row, where: Partial<Row>): boolean {
	return Object.entries(where).every(([key, value]) => row[key as keyof Row] === value);
}

jest.unstable_mockModule('@masumi/payment-core/db', () => ({
	prisma: {
		hydraHeadError: {
			findFirst: async ({ where }: { where: Partial<Row> }) => {
				await Promise.resolve();
				return rows.find((row) => matches(row, where)) ?? null;
			},
			create: async ({ data }: { data: Row }) => {
				await Promise.resolve();
				if (failNextCreate) {
					failNextCreate = false;
					throw new Error('database unavailable');
				}
				rows.push(data);
				return data;
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

beforeEach(() => {
	rows = [];
	failNextCreate = false;
});

function incident(txHash: string): L2MintIncident {
	return { txHash, snapshotNumber: 2, netUnits: { count: 1, sample: [`${'ab'.repeat(28)}61 +1`] } };
}

describe('recordUnburnedL2Mint', () => {
	it('writes one row per incident, however often and however concurrently it is reported', async () => {
		const first = incident('11'.repeat(32));
		await Promise.all([
			recordUnburnedL2Mint('head-repeat', HydraHeadStatus.Open, first),
			recordUnburnedL2Mint('head-repeat', HydraHeadStatus.Open, first),
		]);
		await recordUnburnedL2Mint('head-repeat', HydraHeadStatus.Open, first);
		expect(rows.map((row) => row.txHash)).toEqual([first.txHash]);

		const second = incident('22'.repeat(32));
		await recordUnburnedL2Mint('head-repeat', HydraHeadStatus.Open, second);
		expect(rows.map((row) => row.txHash)).toEqual([first.txHash, second.txHash]);
	});

	// A restart empties the in-process memory; the stored row must still count.
	it('does not repeat a row written before a restart', async () => {
		const known = incident('33'.repeat(32));
		rows.push({ hydraHeadId: 'head-restart', clientInput: 'L2Mint', txHash: known.txHash, errorMessage: '' });

		await recordUnburnedL2Mint('head-restart', HydraHeadStatus.Open, known);

		expect(rows).toHaveLength(1);
	});

	// An operator can clear the head's errors while the head is still blocked.
	it('writes the row again after it was cleared while the incident stays open', async () => {
		jest.useFakeTimers({ doNotFake: ['nextTick', 'queueMicrotask'] });
		try {
			const open = incident('55'.repeat(32));
			await recordUnburnedL2Mint('head-cleared', HydraHeadStatus.Open, open);
			rows = [];

			await recordUnburnedL2Mint('head-cleared', HydraHeadStatus.Open, open);
			expect(rows).toHaveLength(0);
			jest.advanceTimersByTime(10 * 60 * 1000);
			await recordUnburnedL2Mint('head-cleared', HydraHeadStatus.Open, open);

			expect(rows.map((row) => row.txHash)).toEqual([open.txHash]);
		} finally {
			jest.useRealTimers();
		}
	});

	it('tries again on the next report after a failed write', async () => {
		const pending = incident('44'.repeat(32));
		failNextCreate = true;

		await recordUnburnedL2Mint('head-retry', HydraHeadStatus.Open, pending);
		expect(rows).toHaveLength(0);
		await recordUnburnedL2Mint('head-retry', HydraHeadStatus.Open, pending);

		expect(rows.map((row) => row.txHash)).toEqual([pending.txHash]);
	});
});
