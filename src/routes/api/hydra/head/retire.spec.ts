import { beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { Mock } from 'jest-mock';
import { HydraHeadStatus, Prisma } from '@/generated/prisma/client';
import { HydraHeadInitObservationError } from '@/lib/hydra/hydra/head-init-validation';

type AnyMock = Mock<(...args: any[]) => any>;

const mockFindHead = jest.fn() as AnyMock;
const mockUpdateMany = jest.fn() as AnyMock;
const mockReadChain = jest.fn() as AnyMock;
const mockGetNode = jest.fn() as AnyMock;
const mockReconcileEnabledState = jest.fn() as AnyMock;
const mockForgetFailedClosed = jest.fn() as AnyMock;

jest.unstable_mockModule('@masumi/payment-core/auth', () => ({
	adminAuthenticatedEndpointFactory: { build: (definition: unknown) => definition },
}));
jest.unstable_mockModule('@masumi/payment-core/db', () => ({
	prisma: { hydraHead: { findUnique: mockFindHead, updateMany: mockUpdateMany } },
}));
jest.unstable_mockModule('@masumi/payment-core/logger', () => ({
	logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.unstable_mockModule('./chain-check', () => ({ readHeadChainState: mockReadChain }));
jest.unstable_mockModule('@/services/hydra-connection-manager/head-auto-disable-recovery', () => ({
	forgetHeadFailedClosed: mockForgetFailedClosed,
}));
jest.unstable_mockModule('@/services/hydra-connection-manager/hydra-connection-manager.service', () => ({
	getHydraConnectionManager: () => ({ getNode: mockGetNode, reconcileEnabledState: mockReconcileEnabledState }),
}));

let handler: (args: { input: Record<string, unknown> }) => Promise<Record<string, unknown>>;

beforeAll(async () => {
	const { retireHeadPost } = await import('./retire');
	handler = (retireHeadPost as unknown as { handler: typeof handler }).handler;
});

const HEAD_OUTPUT_TX = 'cd'.repeat(32);
const OUTPUT = {
	address: 'addr_test1vz',
	value: { lovelace: 2_000_000 },
	referenceScript: null,
	inlineDatum: null,
	inlineDatumRaw: null,
	datum: null,
};
const REMAINING = { [`${'aa'.repeat(32)}#0`]: OUTPUT };
const AFTER_STEP = { [`${'bb'.repeat(32)}#1`]: OUTPUT };
/** As stored: Prisma JSON holds the BigInt quantity as a string. */
const stored = (utxo: Record<string, typeof OUTPUT>) =>
	Object.fromEntries(
		Object.entries(utxo).map(([reference, output]) => [reference, { ...output, value: { lovelace: '2000000' } }]),
	);
/** `GET /head` for a closed head, before any fanout step. */
const closedNodeState = (utxo: Record<string, unknown>) => ({
	tag: 'Closed',
	contents: {
		version: 0,
		confirmedSnapshot: {
			tag: 'ConfirmedSnapshot',
			snapshot: { version: 0, utxo, utxoToCommit: null, utxoToDecommit: null },
		},
	},
});
const fanningOutNodeState = (remainingOutputs: Record<string, unknown>, mode: string) => ({
	tag: 'FanoutProgress',
	contents: { remainingOutputs, mode: { tag: mode } },
});
const input = {
	headId: 'head-1',
	reason: 'An oversized output blocks the final fanout step',
	acknowledgeStrandedFunds: true,
};
const fanoutPossible = {
	id: 'head-1',
	status: HydraHeadStatus.FanoutPossible,
	retiredAt: null,
	contestationDeadline: new Date(Date.now() - 60_000),
};

beforeEach(() => {
	jest.resetAllMocks();
	mockFindHead.mockResolvedValue(fanoutPossible);
	mockReadChain.mockResolvedValue({ state: 'closed', latestTxHash: HEAD_OUTPUT_TX });
	mockGetNode.mockReturnValue({ get: async () => closedNodeState(REMAINING) });
	mockUpdateMany.mockResolvedValue({ count: 1 });
});

describe('retireHeadPost', () => {
	it('retires a head L1 shows closed and keeps what a recovery needs', async () => {
		await expect(handler({ input })).resolves.toMatchObject({
			headId: 'head-1',
			status: HydraHeadStatus.FanoutPossible,
			retiredHeadOutputTxHash: HEAD_OUTPUT_TX,
			remainingUtxoCount: 1,
		});

		const update = mockUpdateMany.mock.calls[0]![0] as { where: unknown; data: Record<string, unknown> };
		expect(update.where).toEqual({ id: 'head-1', status: HydraHeadStatus.FanoutPossible, retiredAt: null });
		expect(update.data).toMatchObject({
			isEnabled: false,
			// Fences the old session: its status writes match no row after this.
			ownerEpoch: { increment: 1 },
			retiredReason: input.reason,
			retiredRemainingUtxo: stored(REMAINING),
			retiredHeadOutputTxHash: HEAD_OUTPUT_TX,
		});
		// A later recovery restarts the node from the init anchors.
		expect(update.data).not.toHaveProperty('initTxHash');
		expect(update.data).not.toHaveProperty('initChainSlot');
		expect(mockForgetFailedClosed).toHaveBeenCalledWith('head-1');
		expect(mockReconcileEnabledState).toHaveBeenCalledWith('head-1');
	});

	it.each([HydraHeadStatus.Open, HydraHeadStatus.Final, HydraHeadStatus.Initializing])(
		'refuses a %s head',
		async (status) => {
			mockFindHead.mockResolvedValue({ ...fanoutPossible, status });

			await expect(handler({ input })).rejects.toMatchObject({ statusCode: 409 });
			expect(mockReadChain).not.toHaveBeenCalled();
			expect(mockUpdateMany).not.toHaveBeenCalled();
		},
	);

	// During FanningOut the snapshot still shows everything; only the node's
	// head state reports what is left.
	it('stores what the node still holds for a FanningOut head', async () => {
		mockFindHead.mockResolvedValue({ ...fanoutPossible, status: HydraHeadStatus.FanningOut });
		mockGetNode.mockReturnValue({ get: async () => fanningOutNodeState(AFTER_STEP, 'AwaitingSelection') });

		await handler({ input });

		const update = mockUpdateMany.mock.calls[0]![0] as { data: Record<string, unknown> };
		expect(update.data.retiredRemainingUtxo).toEqual(stored(AFTER_STEP));
	});

	// A head the node is still draining is settling, not stuck. Acknowledging an
	// unknown set does not override that: the set is known.
	it.each([false, true])('refuses while the node fans out on its own (acknowledged=%s)', async (acknowledged) => {
		mockFindHead.mockResolvedValue({ ...fanoutPossible, status: HydraHeadStatus.FanningOut });
		mockGetNode.mockReturnValue({ get: async () => fanningOutNodeState(AFTER_STEP, 'AutoDrain') });

		await expect(handler({ input: { ...input, acknowledgeRemainingUtxoUnknown: acknowledged } })).rejects.toMatchObject(
			{ statusCode: 409 },
		);
		expect(mockUpdateMany).not.toHaveBeenCalled();
	});

	// The ADR 0013 case: the final step holds the oversized output, cannot
	// post, and the node stays in AutoDrain with that output left.
	it('retires a head stuck in a drain once the stall is acknowledged', async () => {
		mockFindHead.mockResolvedValue({ ...fanoutPossible, status: HydraHeadStatus.FanningOut });
		mockGetNode.mockReturnValue({ get: async () => fanningOutNodeState(AFTER_STEP, 'AutoDrain') });

		await handler({ input: { ...input, acknowledgeFanoutStalled: true } });

		const update = mockUpdateMany.mock.calls[0]![0] as { data: Record<string, unknown> };
		expect(update.data.retiredRemainingUtxo).toEqual(stored(AFTER_STEP));
	});

	it('refuses a head that is already retired', async () => {
		mockFindHead.mockResolvedValue({ ...fanoutPossible, retiredAt: new Date() });

		await expect(handler({ input })).rejects.toMatchObject({ statusCode: 409 });
		expect(mockUpdateMany).not.toHaveBeenCalled();
	});

	it('refuses a Closed head inside its contestation period', async () => {
		mockFindHead.mockResolvedValue({
			...fanoutPossible,
			status: HydraHeadStatus.Closed,
			contestationDeadline: new Date(Date.now() + 60_000),
		});

		await expect(handler({ input })).rejects.toMatchObject({ statusCode: 409 });
		expect(mockReadChain).not.toHaveBeenCalled();
	});

	it('refuses a Closed head whose contestation deadline is unknown', async () => {
		mockFindHead.mockResolvedValue({ ...fanoutPossible, status: HydraHeadStatus.Closed, contestationDeadline: null });

		await expect(handler({ input })).rejects.toMatchObject({ statusCode: 409 });
		expect(mockReadChain).not.toHaveBeenCalled();
	});

	// The node reports ReadyToFanout before this service stores it.
	it('refuses a Closed head the node already reports FanoutPossible', async () => {
		mockFindHead.mockResolvedValue({ ...fanoutPossible, status: HydraHeadStatus.Closed });
		mockGetNode.mockReturnValue({ status: HydraHeadStatus.FanoutPossible, snapshotUTxO: async () => REMAINING });

		await expect(handler({ input })).rejects.toMatchObject({ statusCode: 409 });
		expect(mockUpdateMany).not.toHaveBeenCalled();
	});

	it('retires a Closed head past its contestation deadline', async () => {
		mockFindHead.mockResolvedValue({ ...fanoutPossible, status: HydraHeadStatus.Closed });

		await expect(handler({ input })).resolves.toMatchObject({ status: HydraHeadStatus.Closed });
	});

	it.each([
		['gone', 409],
		['open', 409],
	])('refuses when L1 shows the head %s', async (state, statusCode) => {
		mockReadChain.mockResolvedValue({ state, latestTxHash: HEAD_OUTPUT_TX });

		await expect(handler({ input })).rejects.toMatchObject({ statusCode });
		expect(mockUpdateMany).not.toHaveBeenCalled();
	});

	it('reports missing L1 evidence as unavailable and other read failures as upstream errors', async () => {
		mockReadChain.mockRejectedValueOnce(new HydraHeadInitObservationError('not indexed yet'));
		await expect(handler({ input })).rejects.toMatchObject({ statusCode: 503 });

		mockReadChain.mockRejectedValueOnce(new Error('socket hang up'));
		await expect(handler({ input })).rejects.toMatchObject({ statusCode: 502 });
		expect(mockUpdateMany).not.toHaveBeenCalled();
	});

	it('refuses when the node cannot report the remaining set, unless that is acknowledged', async () => {
		mockGetNode.mockReturnValue(undefined);

		await expect(handler({ input })).rejects.toMatchObject({ statusCode: 503 });
		expect(mockUpdateMany).not.toHaveBeenCalled();

		await expect(handler({ input: { ...input, acknowledgeRemainingUtxoUnknown: true } })).resolves.toMatchObject({
			remainingUtxoCount: null,
		});
		const update = mockUpdateMany.mock.calls[0]![0] as { data: Record<string, unknown> };
		expect(update.data.retiredRemainingUtxo).toBe(Prisma.DbNull);
	});

	// The node sees a fanout before this service stores it.
	it.each([HydraHeadStatus.FanningOut, HydraHeadStatus.Final])(
		'refuses while the node already reports the head %s',
		async (nodeStatus) => {
			mockGetNode.mockReturnValue({ status: nodeStatus, get: async () => closedNodeState(REMAINING) });

			await expect(handler({ input })).rejects.toMatchObject({ statusCode: 409 });
			expect(mockUpdateMany).not.toHaveBeenCalled();
		},
	);

	it('refuses when a fanout lands on L1 while the remaining set is read', async () => {
		mockReadChain
			.mockResolvedValueOnce({ state: 'closed', latestTxHash: HEAD_OUTPUT_TX })
			.mockResolvedValueOnce({ state: 'closed', latestTxHash: 'ef'.repeat(32) });

		await expect(handler({ input })).rejects.toMatchObject({ statusCode: 409 });
		expect(mockUpdateMany).not.toHaveBeenCalled();
	});

	it('refuses when the head is gone from L1 on the second read', async () => {
		mockReadChain
			.mockResolvedValueOnce({ state: 'closed', latestTxHash: HEAD_OUTPUT_TX })
			.mockResolvedValueOnce({ state: 'gone', latestTxHash: 'ef'.repeat(32) });

		await expect(handler({ input })).rejects.toMatchObject({ statusCode: 409 });
		expect(mockUpdateMany).not.toHaveBeenCalled();
	});

	it('does not retire a head that moved on while it was checked', async () => {
		mockUpdateMany.mockResolvedValue({ count: 0 });

		await expect(handler({ input })).rejects.toMatchObject({ statusCode: 409 });
		expect(mockReconcileEnabledState).not.toHaveBeenCalled();
		// The head was not retired, so it keeps its automatic recovery.
		expect(mockForgetFailedClosed).not.toHaveBeenCalled();
	});
});
