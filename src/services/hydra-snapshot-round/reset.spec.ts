import { beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { Mock } from 'jest-mock';
import type { HydraSnapshotRound } from '@/lib/hydra/hydra/node-control-queries';

type AnyMock = Mock<(...args: any[]) => any>;

const mockFindUnique = jest.fn() as AnyMock;
const mockUpdateMany = jest.fn() as AnyMock;
const mockGetNode = jest.fn() as AnyMock;
const mockFetchRound = jest.fn() as AnyMock;
const mockWarn = jest.fn() as AnyMock;

jest.unstable_mockModule('@masumi/payment-core/db', () => ({
	prisma: { hydraHead: { findUnique: mockFindUnique, updateMany: mockUpdateMany } },
}));
jest.unstable_mockModule('@masumi/payment-core/logger', () => ({
	logger: { info: jest.fn(), warn: mockWarn, error: jest.fn(), debug: jest.fn() },
}));
jest.unstable_mockModule('@/services/hydra-connection-manager/hydra-connection-manager.service', () => ({
	getHydraConnectionManager: () => ({ getNode: mockGetNode }),
}));
jest.unstable_mockModule('@/lib/hydra/hydra/node-control-queries', () => ({
	fetchHydraSnapshotRound: mockFetchRound,
}));
jest.unstable_mockModule('@/services/webhooks/events.service', () => ({
	webhookEventsService: { triggerHydraHeadSnapshotRoundStuck: jest.fn() },
}));

class FakeAmbiguousError extends Error {}
jest.unstable_mockModule('@/lib/hydra', () => ({ HydraTransportAmbiguousError: FakeAmbiguousError }));

let resetSnapshotRound: typeof import('./reset').resetSnapshotRound;
let getSnapshotRoundStatus: typeof import('./reset').getSnapshotRoundStatus;

beforeAll(async () => {
	({ resetSnapshotRound, getSnapshotRoundStatus } = await import('./reset'));
});

const HEAD_IDENTIFIER = 'f6ec7beb99b731e4f2d359d6e77c0b429c7c8b98ddceb234a7622cae';
const SIGNATURE = 'SeenSnapshot|314|1';
const TX_ID = 'dc3edee5c3eb0b5b50809ec9fa41fb590818412383da4f03cbf645fb0c1728e7';

function round(overrides: Partial<HydraSnapshotRound> = {}): HydraSnapshotRound {
	return {
		inFlight: true,
		tag: 'SeenSnapshot',
		number: 314,
		signatoryCount: 1,
		txIds: [TX_ID],
		signature: SIGNATURE,
		...overrides,
	};
}
const idle = round({
	inFlight: false,
	tag: 'LastSeenSnapshot',
	number: null,
	txIds: [],
	signature: 'LastSeenSnapshot|-|0',
});

function headRow(overrides: Record<string, unknown> = {}) {
	return {
		id: 'head-1',
		isEnabled: true,
		status: 'Open',
		headIdentifier: HEAD_IDENTIFIER,
		snapshotRoundSignature: SIGNATURE,
		snapshotRoundSince: new Date(Date.now() - 30 * 60_000),
		LocalParticipant: { id: 'participant-1' },
		...overrides,
	};
}

const confirmedSnapshot = (overrides: Record<string, unknown> = {}) => ({
	tag: 'ConfirmedSnapshot',
	signatures: { multiSignature: ['a', 'b'] },
	snapshot: { headId: HEAD_IDENTIFIER, number: 313, version: 52, accumulator: '12e9', utxo: {}, ...overrides },
});

let node: { get: AnyMock; post: AnyMock; verifiedSnapshotNumber: bigint | undefined; expectedHeadId: string };

beforeEach(() => {
	jest.clearAllMocks();
	node = {
		get: jest.fn(async () => confirmedSnapshot()) as AnyMock,
		post: jest.fn(async () => ({})) as AnyMock,
		verifiedSnapshotNumber: 313n,
		expectedHeadId: HEAD_IDENTIFIER,
	};
	mockGetNode.mockReturnValue(node as never);
	mockFindUnique.mockResolvedValue(headRow() as never);
	mockUpdateMany.mockResolvedValue({ count: 1 } as never);
	// clearAllMocks keeps queued Once values, so a test that stops early would leak its read-back.
	mockFetchRound
		.mockReset()
		.mockResolvedValueOnce(round() as never)
		.mockResolvedValueOnce(idle as never);
});

const reset = () => resetSnapshotRound({ headId: 'head-1', expectedSignature: SIGNATURE, actorApiKeyId: 'admin-key' });

async function expectRefused(status: number) {
	await expect(reset()).rejects.toMatchObject({ status });
	expect(node.post).not.toHaveBeenCalled();
	expect(mockUpdateMany).not.toHaveBeenCalled();
}

describe('resetSnapshotRound', () => {
	it("side-loads exactly the node's own confirmed snapshot and clears the recorded round", async () => {
		const result = await reset();

		expect(node.get).toHaveBeenCalledWith('/snapshot');
		expect(node.post).toHaveBeenCalledWith('/snapshot', confirmedSnapshot());
		expect(mockUpdateMany).toHaveBeenCalledWith({
			where: { id: 'head-1', snapshotRoundSignature: SIGNATURE },
			data: { snapshotRoundSignature: null, snapshotRoundSince: null, snapshotRoundAlertedAt: null },
		});
		expect(result).toEqual({
			headId: 'head-1',
			confirmedSnapshotNumber: 313,
			droppedTxIds: [TX_ID],
			roundAfter: { tag: 'LastSeenSnapshot', snapshotNumber: null },
		});
		expect(mockWarn).toHaveBeenCalledWith(
			'[HydraSnapshotRound] admin is resetting a stuck snapshot round',
			expect.objectContaining({ actorApiKeyId: 'admin-key', droppedTxIds: [TX_ID] }),
		);
	});

	it('refuses when this instance holds no session for the head', async () => {
		mockGetNode.mockReturnValue(null as never);
		await expectRefused(502);
	});

	it('refuses a head that is not open, disabled, or has no local participant', async () => {
		mockFindUnique.mockResolvedValueOnce(headRow({ status: 'Closed' }) as never);
		await expectRefused(409);
		mockFindUnique.mockResolvedValueOnce(headRow({ isEnabled: false }) as never);
		await expectRefused(409);
		mockFindUnique.mockResolvedValueOnce(headRow({ LocalParticipant: null }) as never);
		await expectRefused(400);
		mockFindUnique.mockResolvedValueOnce(null as never);
		await expectRefused(404);
	});

	it('refuses when no round is in flight', async () => {
		mockFetchRound.mockReset().mockResolvedValue(idle as never);
		await expectRefused(409);
	});

	it('refuses when the round changed since the admin saw it', async () => {
		mockFetchRound
			.mockReset()
			.mockResolvedValue(round({ signature: 'SeenSnapshot|314|2', signatoryCount: 2 }) as never);
		await expectRefused(409);
	});

	it('refuses a stuck round other than the one the admin approved', async () => {
		await expect(
			resetSnapshotRound({ headId: 'head-1', expectedSignature: 'SeenSnapshot|313|1', actorApiKeyId: 'admin-key' }),
		).rejects.toMatchObject({ status: 409 });
		expect(node.post).not.toHaveBeenCalled();
	});

	it('refuses a round that has not been stuck for the threshold', async () => {
		mockFindUnique.mockResolvedValue(headRow({ snapshotRoundSince: new Date(Date.now() - 5 * 60_000) }) as never);
		await expectRefused(409);
	});

	it('refuses when the recorded round is a different one, so its clock does not count', async () => {
		mockFindUnique.mockResolvedValue(headRow({ snapshotRoundSignature: 'SeenSnapshot|313|1' }) as never);
		await expectRefused(409);
	});

	it('refuses before the service has verified the confirmed snapshot', async () => {
		node.verifiedSnapshotNumber = undefined;
		await expectRefused(409);
	});

	it('refuses a node with no signed snapshot', async () => {
		node.get.mockResolvedValue({ tag: 'InitialSnapshot', headId: HEAD_IDENTIFIER } as never);
		await expectRefused(409);
	});

	it('refuses a confirmed snapshot for another head', async () => {
		node.get.mockResolvedValue(confirmedSnapshot({ headId: 'a'.repeat(56) }) as never);
		await expectRefused(409);
	});

	it('refuses a confirmed snapshot other than the one this service verified', async () => {
		node.get.mockResolvedValue(confirmedSnapshot({ number: 312 }) as never);
		await expectRefused(409);
	});

	it('refuses when the round in flight is not newer than the confirmed snapshot', async () => {
		mockFetchRound.mockReset().mockResolvedValue(round({ number: 313, signature: 'SeenSnapshot|313|1' }) as never);
		mockFindUnique.mockResolvedValue(headRow({ snapshotRoundSignature: 'SeenSnapshot|313|1' }) as never);
		await expect(
			resetSnapshotRound({ headId: 'head-1', expectedSignature: 'SeenSnapshot|313|1', actorApiKeyId: 'admin-key' }),
		).rejects.toMatchObject({ status: 409 });
		expect(node.post).not.toHaveBeenCalled();
	});

	it('reports an unanswered reset as unknown and keeps the recorded round', async () => {
		node.post.mockRejectedValue(new FakeAmbiguousError('lost') as never);
		await expect(reset()).rejects.toMatchObject({ status: 504 });
		expect(mockUpdateMany).not.toHaveBeenCalled();
	});

	it('reports a refused reset and keeps the recorded round', async () => {
		node.post.mockRejectedValue(new Error('400 SideLoadSnapshotFailed') as never);
		await expect(reset()).rejects.toMatchObject({ status: 502 });
		expect(mockUpdateMany).not.toHaveBeenCalled();
	});

	it('reports a round that is still stuck after the reset', async () => {
		mockFetchRound.mockReset().mockResolvedValue(round() as never);
		await expect(reset()).rejects.toMatchObject({ status: 502 });
		expect(mockUpdateMany).not.toHaveBeenCalled();
	});

	it('still succeeds when the round cannot be read back', async () => {
		mockFetchRound
			.mockReset()
			.mockResolvedValueOnce(round() as never)
			.mockRejectedValueOnce(new Error('down') as never);
		await expect(reset()).resolves.toMatchObject({ roundAfter: null });
	});

	it('runs one reset per head at a time', async () => {
		let release: () => void = () => undefined;
		node.post.mockImplementation(() => new Promise((resolve) => (release = () => resolve({}))));
		const first = reset();
		await new Promise((resolve) => setImmediate(resolve));
		await expect(reset()).rejects.toMatchObject({ status: 409 });
		release();
		await expect(first).resolves.toMatchObject({ confirmedSnapshotNumber: 313 });
	});
});

describe('getSnapshotRoundStatus', () => {
	it('attaches the recorded clock only to the round it was recorded for', async () => {
		mockFetchRound.mockReset().mockResolvedValue(round() as never);
		await expect(getSnapshotRoundStatus('head-1')).resolves.toMatchObject({ stuck: true, signature: SIGNATURE });

		mockFindUnique.mockResolvedValue(headRow({ snapshotRoundSignature: 'SeenSnapshot|313|1' }) as never);
		await expect(getSnapshotRoundStatus('head-1')).resolves.toMatchObject({ stuck: false, since: null });
	});
});
