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
let HydraHttpResponseError: typeof import('@/lib/hydra/hydra/node-http-response').HydraHttpResponseError;

beforeAll(async () => {
	({ recoverHydraDeposit } = await import('./recover'));
	({ HydraHttpResponseError } = await import('@/lib/hydra/hydra/node-http-response'));
});

beforeEach(() => {
	jest.clearAllMocks();
	mockTopupFindUnique.mockResolvedValue({
		id: 'topup-1',
		depositTxHash: 'aa'.repeat(32),
		status: 'Failed',
		hydraHeadId: 'head-1',
		nodeDeadline: null,
		HydraHead: { status: 'Open' },
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

/** The top-up row, with the head status the service last recorded. */
function recordedAs(headStatus: string) {
	mockTopupFindUnique.mockResolvedValue({
		id: 'topup-1',
		depositTxHash: DEPOSIT_TX,
		status: 'Failed',
		hydraHeadId: 'head-1',
		nodeDeadline: null,
		HydraHead: { status: headStatus },
	});
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
			HydraHead: { status: 'Open' },
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
			HydraHead: { status: 'Open' },
		});
		mockAssertNotStopping.mockRejectedValue(Object.assign(new Error('stopped'), { status: 409 }));

		await expect(recoverHydraDeposit('topup-1')).rejects.toMatchObject({ status: 409 });
		expect(mockAssertNotStopping).toHaveBeenCalledWith('head-1');
		expect(mockNodeDelete).not.toHaveBeenCalled();
		expect(mockTopupUpdateMany).not.toHaveBeenCalled();
	});

	// A signed snapshot keeps an acknowledged deposit until a later snapshot
	// replaces it. Recovering it before then can stop an open head from
	// confirming any later snapshot.
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

		// An increment can claim a deposit only before its deadline, so telling
		// the operator to wait for one past it, or with no known deadline, would
		// have them wait for good.
		it.each([
			['ahead', 60_000, 'Wait until the head absorbs it or the deadline passes'],
			['passed', -60_000, 'the head can no longer absorb it'],
			['not recorded', null, 'whether the head can still absorb it is unknown'],
		])('says what to do when its deadline is %s', async (_label, offsetMs, expected) => {
			mockTopupFindUnique.mockResolvedValue({
				id: 'topup-1',
				depositTxHash: DEPOSIT_TX,
				status: 'Failed',
				hydraHeadId: 'head-1',
				nodeDeadline: offsetMs === null ? null : new Date(Date.now() + offsetMs),
				HydraHead: { status: 'Open' },
			});
			nodeAnswers({ snapshot: acknowledged(DEPOSIT_TX) });

			await expect(recoverHydraDeposit('topup-1')).resolves.toMatchObject({
				requested: false,
				reason: expect.stringContaining(expected),
			});
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

		// A closed head confirms no more snapshots and fans out only what it holds,
		// so holding the recovery back until fanout would only delay the funds.
		it.each(['Closed', 'FanoutPossible', 'FanningOut', 'Final'])('is recovered once the head is %s', async (status) => {
			recordedAs(status);
			nodeAnswers({ snapshot: acknowledged(DEPOSIT_TX) });

			await expect(recoverHydraDeposit('topup-1')).resolves.toMatchObject({ requested: true });
			expect(mockNodeDelete).toHaveBeenCalledWith(`/commits/${DEPOSIT_TX}`);
		});

		// The recorded status can lag the node, so a head recorded below Closed
		// may still be open.
		it.each(['Idle', 'Initializing'])('is not recovered while the head is recorded as %s', async (status) => {
			recordedAs(status);
			nodeAnswers({ snapshot: acknowledged(DEPOSIT_TX) });

			await expect(recoverHydraDeposit('topup-1')).resolves.toMatchObject({ requested: false });
			expect(mockNodeDelete).not.toHaveBeenCalled();
		});

		it('is recoverable while the confirmed snapshot is the initial one', async () => {
			nodeAnswers({ snapshot: { tag: 'InitialSnapshot', headId: HEAD_ID } });

			await expect(recoverHydraDeposit('topup-1')).resolves.toMatchObject({ requested: true });
			expect(mockNodeDelete).toHaveBeenCalled();
		});
	});

	// After fanout the node is Idle and answers GET /snapshot with 404. The
	// service records such a head as Final, but one recorded as Idle still
	// reaches the check, and recovery is the only way back for a deposit the
	// head never absorbed.
	it('recovers a deposit of a head that has fanned out', async () => {
		recordedAs('Idle');
		mockNodeGet.mockImplementation(async (path: string) => {
			if (path === '/snapshot/last-seen') return { tag: 'NoSeenSnapshot' };
			throw new HydraHttpResponseError('Hydra HTTP request failed with 404 Not Found', 404);
		});

		await expect(recoverHydraDeposit('topup-1')).resolves.toMatchObject({ requested: true });
		expect(mockNodeDelete).toHaveBeenCalledWith(`/commits/${DEPOSIT_TX}`);
	});

	// Not being able to tell is not permission: the delete cannot be taken back.
	it('does not recover when the node cannot be asked, and names the cause', async () => {
		mockNodeGet.mockRejectedValue(new Error('connection reset'));

		await expect(recoverHydraDeposit('topup-1')).resolves.toMatchObject({
			depositTxHash: DEPOSIT_TX,
			requested: false,
			reason: expect.stringContaining('(connection reset)'),
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
