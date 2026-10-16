/**
 * A Close latch is released only on proof, never on age.
 *
 * The reaper used to clear `isClosing` on any head latched for more than ten
 * minutes whose node still reported it Open. Neither fact shows the Close is
 * dead: a node behind the chain parks the command and posts it once synced, so
 * the head could close after the latch was gone — with new L2 work admitted in
 * between that the ledger would never see. Release now needs the node's refusal
 * of this Close on record and an independent L1 read showing the head Open.
 */

import { beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { Mock } from 'jest-mock';
import { HydraHeadStatus } from '@/generated/prisma/client';

type AnyMock = Mock<(...args: any[]) => any>;

type HeadRow = {
	id: string;
	status: HydraHeadStatus;
	isEnabled: boolean;
	isClosing: boolean;
	closeTxHash: string | null;
	closingSince: Date | null;
	closeRefusedAt: Date | null;
	initTxHash: string | null;
};

let row: HeadRow;

/**
 * Equality, `{ not: null }`, and `{ lt: Date }` — the last so the age-based
 * reaper this replaced can be run against the same cases and seen to fail.
 */
function matches(where: Record<string, unknown>): boolean {
	return Object.entries(where).every(([key, expected]) => {
		const actual = row[key as keyof HeadRow];
		if (expected !== null && typeof expected === 'object' && !(expected instanceof Date)) {
			if ('not' in expected && (expected as { not: unknown }).not === null) return actual !== null;
			if ('lt' in expected) return actual instanceof Date && actual < (expected as { lt: Date }).lt;
			throw new Error(`Unsupported filter on ${key}`);
		}
		if (expected instanceof Date) return actual instanceof Date && actual.getTime() === expected.getTime();
		return actual === expected;
	});
}

const mockFindMany = jest.fn((args: { where: Record<string, unknown> }) =>
	Promise.resolve(matches(args.where) ? [{ id: row.id, closeRefusedAt: row.closeRefusedAt }] : []),
);
const mockUpdateMany = jest.fn((args: { where: Record<string, unknown>; data: Partial<HeadRow> }) => {
	if (!matches(args.where)) return Promise.resolve({ count: 0 });
	row = { ...row, ...args.data };
	return Promise.resolve({ count: 1 });
});
const mockGetHead = jest.fn() as AnyMock;
const mockFlushHeadStatus = jest.fn() as AnyMock;
const mockReadHeadChainState = jest.fn() as AnyMock;

jest.unstable_mockModule('@masumi/payment-core/db', () => ({
	prisma: { hydraHead: { findMany: mockFindMany, updateMany: mockUpdateMany } },
}));

jest.unstable_mockModule('@masumi/payment-core/logger', () => ({
	logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

jest.unstable_mockModule('@/services/hydra-connection-manager/hydra-connection-manager.service', () => ({
	getHydraConnectionManager: () => ({ getHead: mockGetHead, flushHeadStatus: mockFlushHeadStatus }),
}));

jest.unstable_mockModule('@/routes/api/hydra/head/chain-check', () => ({
	readHeadChainState: mockReadHeadChainState,
}));

let releaseStalledCloseAdmissions: typeof import('./index').releaseStalledCloseAdmissions;
let lockOpenHydraHeadForL2Reservation: typeof import('../../../packages/payment-source-v2/src/services/l2-submission').lockOpenHydraHeadForL2Reservation;

beforeAll(async () => {
	({ releaseStalledCloseAdmissions } = await import('./index'));
	({ lockOpenHydraHeadForL2Reservation } =
		await import('../../../packages/payment-source-v2/src/services/l2-submission'));
});

const ELEVEN_MINUTES_MS = 11 * 60 * 1000;

beforeEach(() => {
	jest.clearAllMocks();
	row = {
		id: 'head-1',
		status: HydraHeadStatus.Open,
		isEnabled: true,
		isClosing: true,
		closeTxHash: null,
		closingSince: new Date(Date.now() - ELEVEN_MINUTES_MS),
		closeRefusedAt: null,
		initTxHash: 'a'.repeat(64),
	};
	mockGetHead.mockReturnValue({});
	mockFlushHeadStatus.mockResolvedValue(undefined);
	mockReadHeadChainState.mockResolvedValue({ state: 'open', latestTxHash: 'b'.repeat(64) });
});

/** The submission gate reads the head row under lock; hand it the current row. */
async function reserveL2(): Promise<void> {
	const queryRaw = jest.fn(async () => [row]);
	await lockOpenHydraHeadForL2Reservation({ $queryRaw: queryRaw } as never, row.id);
}

describe('releaseStalledCloseAdmissions', () => {
	// The parked-Close case: dispatched, never refused, node still says Open.
	it('keeps a Close queued for more than ten minutes latched, and L2 reservations blocked', async () => {
		await expect(releaseStalledCloseAdmissions()).resolves.toBe(0);

		expect(row.isClosing).toBe(true);
		expect(mockUpdateMany).not.toHaveBeenCalled();
		expect(mockReadHeadChainState).not.toHaveBeenCalled();
		await expect(reserveL2()).rejects.toThrow('Hydra head head-1 is no longer accepting L2 reservations');
	});

	it('never ages the latch itself: no filter on closingSince or updatedAt', async () => {
		await releaseStalledCloseAdmissions();

		const where = mockFindMany.mock.calls[0]?.[0]?.where;
		expect(where).not.toHaveProperty('closingSince');
		expect(where).not.toHaveProperty('updatedAt');
	});

	// A refusal can be another client's Close while ours is still unconfirmed;
	// L1 is only asked once such a CloseTx has had time to reach a block.
	it('does not ask L1 about a refusal younger than the settle window', async () => {
		row.closeRefusedAt = new Date();

		await expect(releaseStalledCloseAdmissions()).resolves.toBe(0);
		expect(mockReadHeadChainState).not.toHaveBeenCalled();
		expect(row.isClosing).toBe(true);
	});

	it('releases a refused Close once L1 shows the head still Open', async () => {
		row.closeRefusedAt = new Date(Date.now() - ELEVEN_MINUTES_MS);

		await expect(releaseStalledCloseAdmissions()).resolves.toBe(1);

		expect(mockReadHeadChainState).toHaveBeenCalledWith('head-1');
		expect(row).toMatchObject({ isClosing: false, closingSince: null, closeRefusedAt: null });
		await expect(reserveL2()).resolves.toBeUndefined();
	});

	// The refusal covers this node's Close only; the other party may have closed.
	it.each(['closed', 'gone'])('keeps a refused Close latched when L1 shows the head %s', async (state) => {
		row.closeRefusedAt = new Date(Date.now() - ELEVEN_MINUTES_MS);
		mockReadHeadChainState.mockResolvedValue({ state, latestTxHash: 'c'.repeat(64) });

		await expect(releaseStalledCloseAdmissions()).resolves.toBe(0);

		expect(row.isClosing).toBe(true);
		await expect(reserveL2()).rejects.toThrow('no longer accepting L2 reservations');
	});

	// The refusal checked against L1 must be the one released. A new attempt
	// refused during this pass has had no settle window of its own.
	it('does not release a newer refusal that landed during the L1 read', async () => {
		row.closeRefusedAt = new Date(Date.now() - ELEVEN_MINUTES_MS);
		mockReadHeadChainState.mockImplementation(async () => {
			row.closeRefusedAt = new Date();
			return { state: 'open', latestTxHash: 'b'.repeat(64) };
		});

		await expect(releaseStalledCloseAdmissions()).resolves.toBe(0);
		expect(row.isClosing).toBe(true);
	});

	it('keeps a refused Close latched when L1 cannot be read', async () => {
		row.closeRefusedAt = new Date(Date.now() - ELEVEN_MINUTES_MS);
		mockReadHeadChainState.mockRejectedValue(new Error('observer down'));

		await expect(releaseStalledCloseAdmissions()).resolves.toBe(0);
		expect(row.isClosing).toBe(true);
	});

	// No session means no authority to say anything about the head.
	it('leaves the latch alone when there is no session for the head', async () => {
		row.closeRefusedAt = new Date(Date.now() - ELEVEN_MINUTES_MS);
		mockGetHead.mockReturnValue(null);

		await expect(releaseStalledCloseAdmissions()).resolves.toBe(0);
		expect(mockReadHeadChainState).not.toHaveBeenCalled();
		expect(row.isClosing).toBe(true);
	});
});
