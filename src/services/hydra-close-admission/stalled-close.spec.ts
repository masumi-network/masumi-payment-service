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
import { HydraErrorType, HydraHeadStatus } from '@/generated/prisma/client';

type AnyMock = Mock<(...args: any[]) => any>;

type HeadRow = {
	id: string;
	status: HydraHeadStatus;
	isEnabled: boolean;
	isClosing: boolean;
	closeTxHash: string | null;
	closingSince: Date | null;
	closeAdmissionId: string | null;
	closeRefusedAt: Date | null;
	initTxHash: string | null;
};

let row: HeadRow;
let errorRows: Array<{
	id: string;
	hydraHeadId: string;
	errorType: HydraErrorType;
	clientInput: string | null;
	errorAt: Date;
}>;

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
	Promise.resolve(
		matches(args.where)
			? [{ id: row.id, closeAdmissionId: row.closeAdmissionId, closeRefusedAt: row.closeRefusedAt }]
			: [],
	),
);
const mockHeadErrorFindFirst = jest.fn() as AnyMock;
const mockExecuteRaw = jest.fn(async (query: { sql: string; values: unknown[] }) => {
	const scopedHeadId = query.values.includes(row.id) ? row.id : null;
	const limit = query.values.find((value) => typeof value === 'number') as number | undefined;
	let deleted = 0;
	errorRows = errorRows.filter((error) => {
		if (scopedHeadId !== null && error.hydraHeadId !== scopedHeadId) return true;
		if (error.errorType !== HydraErrorType.CommandFailed || !error.clientInput?.startsWith('CloseNonexecution:'))
			return true;
		const isActive =
			row.status === HydraHeadStatus.Open &&
			row.isClosing &&
			error.hydraHeadId === row.id &&
			error.clientInput === `CloseNonexecution:${row.closeAdmissionId}`;
		if (isActive || (limit !== undefined && deleted >= limit)) return true;
		deleted += 1;
		return false;
	});
	return deleted;
});
const mockHeadErrorDeleteMany = jest.fn(
	(args: {
		where: {
			hydraHeadId: string;
			OR?: Array<{
				clientInput?: null | { not: { startsWith: string } };
				errorType?: { not: HydraErrorType };
			}>;
			errorType?: HydraErrorType;
			clientInput?: string;
		};
	}) => {
		const before = errorRows.length;
		errorRows = errorRows.filter((error) => {
			if (error.hydraHeadId !== args.where.hydraHeadId) return true;
			if (args.where.errorType !== undefined && error.errorType !== args.where.errorType) return true;
			if (args.where.clientInput !== undefined) return error.clientInput !== args.where.clientInput;
			if (!args.where.OR) return false;
			const matchesClearFilter = args.where.OR.some(({ clientInput, errorType }) => {
				if (errorType !== undefined) return error.errorType !== errorType.not;
				if (clientInput === null) return error.clientInput === null;
				if (clientInput === undefined) return false;
				return error.clientInput !== null && !error.clientInput.startsWith(clientInput.not.startsWith);
			});
			return !matchesClearFilter;
		});
		return Promise.resolve({ count: before - errorRows.length });
	},
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
	prisma: {
		$executeRaw: mockExecuteRaw,
		hydraHead: { findMany: mockFindMany, findUnique: async () => row, updateMany: mockUpdateMany },
		hydraHeadError: { findFirst: mockHeadErrorFindFirst, deleteMany: mockHeadErrorDeleteMany },
	},
}));

jest.unstable_mockModule('@masumi/payment-core/auth', () => ({
	adminAuthenticatedEndpointFactory: { build: (definition: unknown) => definition },
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
let clearHeadErrorsDelete: typeof import('@/routes/api/hydra/head/observability').clearHeadErrorsDelete;

beforeAll(async () => {
	({ releaseStalledCloseAdmissions } = await import('./index'));
	({ lockOpenHydraHeadForL2Reservation } =
		await import('../../../packages/payment-source-v2/src/services/l2-submission'));
	({ clearHeadErrorsDelete } = await import('@/routes/api/hydra/head/observability'));
});

const ELEVEN_MINUTES_MS = 11 * 60 * 1000;

beforeEach(() => {
	jest.clearAllMocks();
	errorRows = [];
	row = {
		id: 'head-1',
		status: HydraHeadStatus.Open,
		isEnabled: true,
		isClosing: true,
		closeTxHash: null,
		closingSince: new Date(Date.now() - ELEVEN_MINUTES_MS),
		closeAdmissionId: 'attempt-1',
		closeRefusedAt: null,
		initTxHash: 'a'.repeat(64),
	};
	mockGetHead.mockReturnValue({});
	mockFlushHeadStatus.mockResolvedValue(undefined);
	mockReadHeadChainState.mockResolvedValue({ state: 'open', latestTxHash: 'b'.repeat(64) });
	mockHeadErrorFindFirst.mockResolvedValue(null);
});

/** The submission gate reads the head row under lock; hand it the current row. */
async function reserveL2(): Promise<void> {
	const queryRaw = jest.fn(async () => [row]);
	await lockOpenHydraHeadForL2Reservation({ $queryRaw: queryRaw } as never, row.id);
}

describe('releaseStalledCloseAdmissions', () => {
	it('keeps the exact fallback proof through clear-errors, then releases the Close latch', async () => {
		const refusal = {
			id: 'refusal-1',
			hydraHeadId: row.id,
			errorType: HydraErrorType.CommandFailed,
			clientInput: `CloseNonexecution:${row.closeAdmissionId}`,
			errorAt: new Date(Date.now() - ELEVEN_MINUTES_MS),
		};
		errorRows.push(
			refusal,
			{ ...refusal, id: 'visible-error', clientInput: 'Close' },
			{ ...refusal, id: 'null-input-error', clientInput: null },
			{ ...refusal, id: 'other-error-type', errorType: HydraErrorType.InvalidInput },
		);
		mockHeadErrorFindFirst.mockImplementation(({ where }: { where: { clientInput: string; errorAt: { lt: Date } } }) =>
			Promise.resolve(
				errorRows.find((error) => error.clientInput === where.clientInput && error.errorAt < where.errorAt.lt) ?? null,
			),
		);

		const clear = clearHeadErrorsDelete as unknown as {
			handler: (params: { input: { headId: string } }) => Promise<{ cleared: number }>;
		};
		await expect(clear.handler({ input: { headId: row.id } })).resolves.toEqual({ cleared: 3 });
		expect(errorRows.map((error) => error.id)).toEqual(['refusal-1']);
		await expect(releaseStalledCloseAdmissions()).resolves.toBe(1);
		expect(row.isClosing).toBe(false);
		expect(errorRows).toEqual([]);
	});

	it('clears a consumed fallback proof after a peer closes the head', async () => {
		row.status = HydraHeadStatus.Closed;
		errorRows.push({
			id: 'peer-close-proof',
			hydraHeadId: row.id,
			errorType: HydraErrorType.CommandFailed,
			clientInput: `CloseNonexecution:${row.closeAdmissionId}`,
			errorAt: new Date(),
		});
		const clear = clearHeadErrorsDelete as unknown as {
			handler: (params: { input: { headId: string } }) => Promise<{ cleared: number }>;
		};

		await expect(clear.handler({ input: { headId: row.id } })).resolves.toEqual({ cleared: 1 });
		expect(errorRows).toEqual([]);
		expect(row.isClosing).toBe(true);
	});

	it('keeps an active proof while disabled, then cleans it after its admission ends', async () => {
		row.isEnabled = false;
		errorRows.push({
			id: 'disabled-proof',
			hydraHeadId: row.id,
			errorType: HydraErrorType.CommandFailed,
			clientInput: `CloseNonexecution:${row.closeAdmissionId}`,
			errorAt: new Date(),
		});
		const clear = clearHeadErrorsDelete as unknown as {
			handler: (params: { input: { headId: string } }) => Promise<{ cleared: number }>;
		};

		await expect(clear.handler({ input: { headId: row.id } })).resolves.toEqual({ cleared: 0 });
		expect(errorRows).toHaveLength(1);
		row.isClosing = false;
		row.closeAdmissionId = null;
		await expect(releaseStalledCloseAdmissions()).resolves.toBe(0);
		expect(errorRows).toEqual([]);
	});

	it('retries a stale proof delete after the latch was released', async () => {
		errorRows.push({
			id: 'retry-proof',
			hydraHeadId: row.id,
			errorType: HydraErrorType.CommandFailed,
			clientInput: `CloseNonexecution:${row.closeAdmissionId}`,
			errorAt: new Date(Date.now() - ELEVEN_MINUTES_MS),
		});
		mockHeadErrorFindFirst.mockResolvedValue({ id: 'retry-proof' });
		mockHeadErrorDeleteMany.mockRejectedValueOnce(new Error('delete failed'));

		await expect(releaseStalledCloseAdmissions()).resolves.toBe(1);
		expect(errorRows.map((error) => error.id)).toEqual(['retry-proof']);
		await expect(releaseStalledCloseAdmissions()).resolves.toBe(0);
		expect(errorRows).toEqual([]);
	});

	it('removes an older admission marker without erasing the current proof', async () => {
		errorRows.push(
			{
				id: 'old-proof',
				hydraHeadId: row.id,
				errorType: HydraErrorType.CommandFailed,
				clientInput: 'CloseNonexecution:attempt-0',
				errorAt: new Date(),
			},
			{
				id: 'active-proof',
				hydraHeadId: row.id,
				errorType: HydraErrorType.CommandFailed,
				clientInput: `CloseNonexecution:${row.closeAdmissionId}`,
				errorAt: new Date(),
			},
		);
		const clear = clearHeadErrorsDelete as unknown as {
			handler: (params: { input: { headId: string } }) => Promise<{ cleared: number }>;
		};

		await expect(clear.handler({ input: { headId: row.id } })).resolves.toEqual({ cleared: 1 });
		expect(errorRows.map((error) => error.id)).toEqual(['active-proof']);
		const query = mockExecuteRaw.mock.calls[mockExecuteRaw.mock.calls.length - 1]?.[0];
		expect(query?.sql).toContain('NOT EXISTS');
		expect(query?.sql).toContain('"closeAdmissionId"');
		expect(query?.sql).toContain('"isClosing"');
		expect(query?.sql).toContain('"status"');
		expect(query?.sql).toContain('"errorType"');
		expect(query?.values).toContain(HydraErrorType.CommandFailed);
	});
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
		expect(row).toMatchObject({ isClosing: false, closingSince: null, closeAdmissionId: null, closeRefusedAt: null });
		await expect(reserveL2()).resolves.toBeUndefined();
	});

	it('releases a Close whose head marker write failed but exact-attempt refusal was saved', async () => {
		const closeAdmissionId = row.closeAdmissionId;
		mockHeadErrorFindFirst.mockResolvedValue({ id: 'refusal-1' });

		await expect(releaseStalledCloseAdmissions()).resolves.toBe(1);

		expect(mockHeadErrorFindFirst).toHaveBeenCalledWith({
			where: {
				hydraHeadId: 'head-1',
				errorType: 'CommandFailed',
				clientInput: `CloseNonexecution:${closeAdmissionId}`,
				errorAt: { lt: expect.any(Date) },
			},
			select: { id: true },
		});
		expect(row.isClosing).toBe(false);
	});

	it("does not use an older attempt's fallback refusal for the current latch", async () => {
		const previousAttempt = 'previous-attempt';
		mockHeadErrorFindFirst.mockImplementation(({ where }: { where: { clientInput: string } }) =>
			Promise.resolve(where.clientInput === `CloseNonexecution:${previousAttempt}` ? { id: 'old-refusal' } : null),
		);

		await expect(releaseStalledCloseAdmissions()).resolves.toBe(0);
		expect(row.isClosing).toBe(true);
		expect(mockReadHeadChainState).not.toHaveBeenCalled();
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

	it('does not release a replacement Close attempt after its own L1 read', async () => {
		mockHeadErrorFindFirst.mockResolvedValue({ id: 'refusal-1' });
		mockReadHeadChainState.mockImplementation(async () => {
			row.closeAdmissionId = 'new-attempt';
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
