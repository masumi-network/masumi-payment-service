import { beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { Mock } from 'jest-mock';
import { HydraHeadStatus } from '@/generated/prisma/client';

type AnyMock = Mock<(...args: any[]) => any>;

const mockFindHead = jest.fn() as AnyMock;
const mockPartialFanout = jest.fn() as AnyMock;
const mockFlushHeadStatus = jest.fn() as AnyMock;
const mockNodeGet = jest.fn() as AnyMock;
const mockRecordHeadError = jest.fn() as AnyMock;

jest.unstable_mockModule('@masumi/payment-core/auth', () => ({
	adminAuthenticatedEndpointFactory: { build: (definition: unknown) => definition },
}));
jest.unstable_mockModule('@masumi/payment-core/db', () => ({
	prisma: { hydraHead: { findUnique: mockFindHead } },
}));
jest.unstable_mockModule('@masumi/payment-core/logger', () => ({
	logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.unstable_mockModule('@/services/hydra-head-error/record', () => ({ recordHeadError: mockRecordHeadError }));
jest.unstable_mockModule('@/services/hydra-connection-manager/hydra-connection-manager.service', () => ({
	getHydraConnectionManager: () => ({
		getHead: () => ({ partialFanout: mockPartialFanout }),
		getNode: () => ({ get: mockNodeGet }),
		flushHeadStatus: mockFlushHeadStatus,
	}),
}));

let handler: (args: { input: Record<string, unknown> }) => Promise<Record<string, unknown>>;
let remainingHandler: typeof handler;

beforeAll(async () => {
	const { partialFanoutHeadPost, fanoutRemainingGet } = await import('./partial-fanout');
	handler = (partialFanoutHeadPost as unknown as { handler: typeof handler }).handler;
	remainingHandler = (fanoutRemainingGet as unknown as { handler: typeof handler }).handler;
});

const OUTPUT = {
	address: 'addr_test1vz',
	value: { lovelace: 2_000_000 },
	referenceScript: null,
	inlineDatum: null,
	inlineDatumRaw: null,
	datum: null,
};
const A = `${'aa'.repeat(32)}#0`;
const B = `${'bb'.repeat(32)}#1`;
const C = `${'cc'.repeat(32)}#2`;
const closedHead = { id: 'head-1', isEnabled: true, status: HydraHeadStatus.FanoutPossible };

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
/** `GET /head` between fanout steps. */
const fanningOutNodeState = (remainingOutputs: Record<string, unknown>, mode: string) => ({
	tag: 'FanoutProgress',
	contents: { remainingOutputs, mode: { tag: mode } },
});

beforeEach(() => {
	jest.resetAllMocks();
	mockFindHead.mockResolvedValueOnce(closedHead).mockResolvedValue({ status: HydraHeadStatus.FanningOut });
	mockNodeGet.mockResolvedValue(closedNodeState({ [A]: OUTPUT, [B]: OUTPUT, [C]: OUTPUT }));
});

describe('fanoutRemainingGet', () => {
	it('lists what a FanningOut head still holds, with the node mode, quantities as strings', async () => {
		mockFindHead.mockReset();
		mockFindHead.mockResolvedValue({ ...closedHead, status: HydraHeadStatus.FanningOut });
		mockNodeGet.mockResolvedValue(fanningOutNodeState({ [C]: OUTPUT }, 'AwaitingSelection'));

		await expect(remainingHandler({ input: { headId: 'head-1' } })).resolves.toEqual({
			headId: 'head-1',
			status: HydraHeadStatus.FanningOut,
			fanoutMode: 'AwaitingSelection',
			outputs: [{ reference: C, address: OUTPUT.address, lovelace: '2000000' }],
		});
		expect(mockNodeGet).toHaveBeenCalledWith('/head');
	});
});

describe('partialFanoutHeadPost', () => {
	it('sends the selected outputs from the closed head state before the first step', async () => {
		await expect(handler({ input: { headId: 'head-1', outputRefs: [A, B.toUpperCase()] } })).resolves.toEqual({
			headId: 'head-1',
			status: HydraHeadStatus.FanningOut,
			selectedCount: 2,
		});

		const selection = mockPartialFanout.mock.calls[0]![0] as Record<string, unknown>;
		expect(Object.keys(selection)).toEqual([A, B]);
		expect(mockNodeGet).toHaveBeenCalledWith('/head');
	});

	// The snapshot still lists outputs earlier steps already moved to L1.
	it('selects from what the node still holds once fanning out', async () => {
		mockFindHead.mockReset();
		mockFindHead.mockResolvedValue({ ...closedHead, status: HydraHeadStatus.FanningOut });
		mockNodeGet.mockResolvedValue(fanningOutNodeState({ [C]: OUTPUT }, 'AwaitingSelection'));

		await expect(handler({ input: { headId: 'head-1', outputRefs: [A] } })).rejects.toMatchObject({
			statusCode: 409,
		});
		expect(mockPartialFanout).not.toHaveBeenCalled();

		await handler({ input: { headId: 'head-1', outputRefs: [C] } });
		expect(Object.keys(mockPartialFanout.mock.calls[0]![0] as object)).toEqual([C]);
	});

	// A selection then replaces the drain in progress, and the node stops
	// once that selection is out instead of finishing the head.
	it.each(['AutoDrain', 'DistributingSelection'])('refuses while the node fans out on its own (%s)', async (mode) => {
		mockFindHead.mockReset();
		mockFindHead.mockResolvedValue({ ...closedHead, status: HydraHeadStatus.FanningOut });
		mockNodeGet.mockResolvedValue(fanningOutNodeState({ [C]: OUTPUT }, mode));

		await expect(handler({ input: { headId: 'head-1', outputRefs: [C] } })).rejects.toMatchObject({
			statusCode: 409,
		});
		expect(mockPartialFanout).not.toHaveBeenCalled();
	});

	// A reverted first step leaves the stored status at FanningOut while the
	// node is back to Closed. The selection then comes from the closed state.
	it('selects from the closed state when the stored status is ahead of the node', async () => {
		mockFindHead.mockReset();
		mockFindHead.mockResolvedValue({ ...closedHead, status: HydraHeadStatus.FanningOut });

		await handler({ input: { headId: 'head-1', outputRefs: [A] } });
		expect(Object.keys(mockPartialFanout.mock.calls[0]![0] as object)).toEqual([A]);
	});

	it('refuses when the node does not hold the head as closed', async () => {
		mockNodeGet.mockResolvedValue({ tag: 'Open', contents: {} });

		await expect(handler({ input: { headId: 'head-1', outputRefs: [A] } })).rejects.toMatchObject({
			statusCode: 409,
		});
		expect(mockPartialFanout).not.toHaveBeenCalled();
	});

	it.each([HydraHeadStatus.Open, HydraHeadStatus.Closed, HydraHeadStatus.Final])(
		'refuses a %s head',
		async (status) => {
			mockFindHead.mockReset();
			mockFindHead.mockResolvedValue({ ...closedHead, status });

			await expect(handler({ input: { headId: 'head-1', outputRefs: [A] } })).rejects.toMatchObject({
				statusCode: 409,
			});
			expect(mockPartialFanout).not.toHaveBeenCalled();
		},
	);

	it('records a refused step on the head', async () => {
		const refused = new Error('Command PartialFanout failed');
		mockPartialFanout.mockRejectedValue(refused);

		await expect(handler({ input: { headId: 'head-1', outputRefs: [A] } })).rejects.toBe(refused);
		expect(mockRecordHeadError).toHaveBeenCalledWith(
			'head-1',
			HydraHeadStatus.FanoutPossible,
			'CommandFailed',
			refused,
			'PartialFanout',
		);
	});
});
