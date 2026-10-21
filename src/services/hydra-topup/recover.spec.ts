import { beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { Mock } from 'jest-mock';

type AnyMock = Mock<(...args: any[]) => any>;

const mockTopupFindUnique = jest.fn() as AnyMock;
const mockTopupUpdateMany = jest.fn() as AnyMock;
const mockAssertNotPaused = jest.fn() as AnyMock;
const mockAssertNotStopping = jest.fn() as AnyMock;
const mockNodeDelete = jest.fn() as AnyMock;
const mockNodeGet = jest.fn() as AnyMock;
const mockGetNode = jest.fn() as AnyMock;

jest.unstable_mockModule('@masumi/payment-core/db', () => ({
	prisma: { hydraTopup: { findUnique: mockTopupFindUnique, updateMany: mockTopupUpdateMany } },
}));
jest.unstable_mockModule('@masumi/payment-core/logger', () => ({
	logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.unstable_mockModule('@/services/hydra-connection-manager/hydra-connection-manager.service', () => ({
	getHydraConnectionManager: () => ({ getNode: mockGetNode }),
}));
jest.unstable_mockModule('@/services/hydra-host/pause', () => ({
	assertHydraHeadHostNotPaused: mockAssertNotPaused,
	assertHydraHeadHostNotStopping: mockAssertNotStopping,
}));

let recoverHydraDeposit: typeof import('./recover').recoverHydraDeposit;
let HydraHttpResponseError: typeof import('@/lib/hydra/hydra/node-frames').HydraHttpResponseError;

beforeAll(async () => {
	({ recoverHydraDeposit } = await import('./recover'));
	({ HydraHttpResponseError } = await import('@/lib/hydra/hydra/node-frames'));
});

beforeEach(() => {
	jest.clearAllMocks();
	mockTopupFindUnique.mockResolvedValue({
		id: 'topup-1',
		depositTxHash: 'aa'.repeat(32),
		status: 'Failed',
		hydraHeadId: 'head-1',
	});
	mockTopupUpdateMany.mockResolvedValue({ count: 1 });
	mockAssertNotPaused.mockResolvedValue(undefined);
	mockAssertNotStopping.mockResolvedValue(undefined);
	mockGetNode.mockReturnValue({ delete: mockNodeDelete, get: mockNodeGet });
	mockNodeDelete.mockResolvedValue(undefined);
	nodeAnswers({});
});

const HEAD_ID = 'cc'.repeat(28);
const DEPOSIT_TX = 'aa'.repeat(32);
const OUTPUT = {
	address: 'addr_test1vz',
	value: { lovelace: 5_000_000 },
	referenceScript: null,
	inlineDatum: null,
	inlineDatumRaw: null,
	datum: null,
};

/** The body hydra-node 2.4.1 returns for GET /snapshot (api.yaml: ConfirmedSnapshot). */
function confirmedSnapshot(fields: { utxoToCommit: Record<string, unknown> | null; depositTxId: string | null }) {
	return {
		tag: 'ConfirmedSnapshot',
		signatures: { multiSignature: [] },
		snapshot: { headId: HEAD_ID, version: 1, number: 7, confirmed: [], utxo: {}, utxoToDecommit: null, ...fields },
	};
}

/** What the node answers for GET /snapshot and GET /snapshot/last-seen. Defaults: no deposit, no round in flight. */
function nodeAnswers(answers: { snapshot?: unknown; lastSeen?: unknown }) {
	mockNodeGet.mockImplementation(async (path: string) =>
		path === '/snapshot/last-seen'
			? (answers.lastSeen ?? { tag: 'LastSeenSnapshot', lastSeen: 7 })
			: (answers.snapshot ?? confirmedSnapshot({ utxoToCommit: null, depositTxId: null })),
	);
}

describe('recoverHydraDeposit', () => {
	it('asks the node to recover a settled deposit', async () => {
		await expect(recoverHydraDeposit('topup-1')).resolves.toMatchObject({ requested: true });
		expect(mockNodeDelete).toHaveBeenCalledWith(`/commits/${'aa'.repeat(32)}`);
	});

	// A recovery is a new L1 transaction from the node.
	it('refuses while the head is on a paused host, before it asks the node', async () => {
		mockAssertNotPaused.mockRejectedValue(Object.assign(new Error('paused'), { status: 409 }));

		await expect(recoverHydraDeposit('topup-1')).rejects.toMatchObject({ status: 409 });
		expect(mockAssertNotPaused).toHaveBeenCalledWith('head-1');
		expect(mockNodeDelete).not.toHaveBeenCalled();
		expect(mockTopupUpdateMany).not.toHaveBeenCalled();
	});

	// A pause waits for a Confirmed deposit, and only a recovery can end one the
	// head never absorbs.
	it('still recovers a Confirmed deposit while the pause drains', async () => {
		mockTopupFindUnique.mockResolvedValue({
			id: 'topup-1',
			depositTxHash: 'aa'.repeat(32),
			status: 'Confirmed',
			hydraHeadId: 'head-1',
		});
		mockAssertNotPaused.mockRejectedValue(Object.assign(new Error('paused'), { status: 409 }));

		await expect(recoverHydraDeposit('topup-1')).resolves.toMatchObject({ requested: true });
		expect(mockNodeDelete).toHaveBeenCalled();
	});

	// Once the nodes are stopped, an unanswered request would read as posted.
	it('refuses a Confirmed deposit once the pause has stopped the nodes', async () => {
		mockTopupFindUnique.mockResolvedValue({
			id: 'topup-1',
			depositTxHash: 'aa'.repeat(32),
			status: 'Confirmed',
			hydraHeadId: 'head-1',
		});
		mockAssertNotStopping.mockRejectedValue(Object.assign(new Error('stopped'), { status: 409 }));

		await expect(recoverHydraDeposit('topup-1')).rejects.toMatchObject({ status: 409 });
		expect(mockAssertNotStopping).toHaveBeenCalledWith('head-1');
		expect(mockNodeDelete).not.toHaveBeenCalled();
		expect(mockTopupUpdateMany).not.toHaveBeenCalled();
	});

	// A deposit the head has acknowledged in a signed snapshot is claimed by an
	// increment that is already on its way; deleting it then wedges the head.
	describe('a deposit the head has acknowledged', () => {
		const acknowledged = (depositTxId: string | null) =>
			confirmedSnapshot({ utxoToCommit: { [`${DEPOSIT_TX}#0`]: OUTPUT }, depositTxId });

		it('is not recovered', async () => {
			nodeAnswers({ snapshot: acknowledged(DEPOSIT_TX) });

			await expect(recoverHydraDeposit('topup-1')).resolves.toMatchObject({
				depositTxHash: DEPOSIT_TX,
				requested: false,
			});
			expect(mockNodeGet).toHaveBeenCalledWith('/snapshot');
			expect(mockNodeDelete).not.toHaveBeenCalled();
			expect(mockTopupUpdateMany).not.toHaveBeenCalled();
		});

		// The round can still confirm once the other signatures arrive.
		it('is not recovered while a round this node has signed holds it', async () => {
			const { snapshot } = acknowledged(DEPOSIT_TX);
			nodeAnswers({ lastSeen: { tag: 'SeenSnapshot', snapshot, signatories: {} } });

			await expect(recoverHydraDeposit('topup-1')).resolves.toMatchObject({ requested: false });
			expect(mockNodeDelete).not.toHaveBeenCalled();
		});

		it('is not recovered when the snapshot does not name which deposit it holds', async () => {
			nodeAnswers({ snapshot: acknowledged(null) });

			await expect(recoverHydraDeposit('topup-1')).resolves.toMatchObject({ requested: false });
			expect(mockNodeDelete).not.toHaveBeenCalled();
		});

		it('is not recovered when the snapshot names it in capitals', async () => {
			nodeAnswers({ snapshot: acknowledged(DEPOSIT_TX.toUpperCase()) });

			await expect(recoverHydraDeposit('topup-1')).resolves.toMatchObject({ requested: false });
			expect(mockNodeDelete).not.toHaveBeenCalled();
		});

		it('leaves another deposit recoverable while this one is acknowledged', async () => {
			nodeAnswers({ snapshot: acknowledged('bb'.repeat(32)) });

			await expect(recoverHydraDeposit('topup-1')).resolves.toMatchObject({ requested: true });
			expect(mockNodeDelete).toHaveBeenCalledWith(`/commits/${DEPOSIT_TX}`);
		});

		it('is recoverable on a head that closed on its initial snapshot', async () => {
			nodeAnswers({ snapshot: { tag: 'InitialSnapshot', headId: HEAD_ID } });

			await expect(recoverHydraDeposit('topup-1')).resolves.toMatchObject({ requested: true });
			expect(mockNodeDelete).toHaveBeenCalled();
		});
	});

	// After fanout the node is Idle and answers GET /snapshot with 404, and
	// recovery is the only way back for a deposit the head never absorbed.
	it('recovers a deposit of a head that has fanned out', async () => {
		mockNodeGet.mockImplementation(async (path: string) => {
			if (path === '/snapshot/last-seen') return { tag: 'NoSeenSnapshot' };
			throw new HydraHttpResponseError('Hydra HTTP request failed with 404 Not Found', 404);
		});

		await expect(recoverHydraDeposit('topup-1')).resolves.toMatchObject({ requested: true });
		expect(mockNodeDelete).toHaveBeenCalledWith(`/commits/${DEPOSIT_TX}`);
	});

	// Not being able to tell is not permission: the delete cannot be taken back.
	it('does not recover when the head state cannot be read', async () => {
		mockNodeGet.mockRejectedValue(new Error('connection reset'));

		await expect(recoverHydraDeposit('topup-1')).resolves.toMatchObject({
			depositTxHash: DEPOSIT_TX,
			requested: false,
			reason: expect.stringContaining('could not check'),
		});
		expect(mockNodeDelete).not.toHaveBeenCalled();
		expect(mockTopupUpdateMany).not.toHaveBeenCalled();
	});

	it('does not recover when the head state is malformed', async () => {
		nodeAnswers({ snapshot: { tag: 'ConfirmedSnapshot', snapshot: { utxoToCommit: 'not-a-map' } } });

		await expect(recoverHydraDeposit('topup-1')).resolves.toMatchObject({ requested: false });
		expect(mockNodeDelete).not.toHaveBeenCalled();
	});
});
