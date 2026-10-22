import { describe, expect, it, jest } from '@jest/globals';
import type { NodeRecord } from '../registry/types.js';
import { holdsUnsettledCommit, roundSignature, unwedgeNode, unwedgeRecord, type UnwedgeOptions } from './unwedge.js';
import type { LastSeenSnapshotResponse } from './drain.js';

const noopSleep = async () => undefined;

function options(overrides: Partial<UnwedgeOptions> = {}): UnwedgeOptions {
	return {
		fetchLastSeen: jest.fn<() => Promise<LastSeenSnapshotResponse>>().mockResolvedValue({ tag: 'NoSeenSnapshot' }),
		fetchConfirmedSnapshot: jest.fn<() => Promise<unknown>>().mockResolvedValue({ snapshot: 'confirmed' }),
		fetchHead: jest.fn<() => Promise<unknown>>().mockResolvedValue({ tag: 'Open' }),
		sideLoadSnapshot: jest.fn<(snapshot: unknown) => Promise<void>>().mockResolvedValue(undefined),
		settleWaitMs: 30_000,
		sleep: noopSleep,
		allowAutoSideLoad: true,
		...overrides,
	};
}

const DEPOSIT = { [`${'dd'.repeat(32)}#0`]: {} };

/** `GET /head` while Open, with the confirmed snapshot at version 3 holding `utxoToCommit`. */
function headHolding(utxoToCommit: unknown, version: number): unknown {
	return {
		tag: 'Open',
		contents: { coordinatedHeadState: { version, confirmedSnapshot: { snapshot: { version: 3, utxoToCommit } } } },
	};
}

describe('holdsUnsettledCommit', () => {
	it('reports an empty commit as unsettled, as hydra checks only that it is set', () => {
		expect(holdsUnsettledCommit(headHolding({}, 3))).toBe(true);
	});

	it.each([
		['the chain has settled it', headHolding(DEPOSIT, 4)],
		['the snapshot holds no commit', headHolding(null, 3)],
		[
			'the head is still on its initial snapshot',
			{
				tag: 'Open',
				contents: { coordinatedHeadState: { version: 0, confirmedSnapshot: { tag: 'InitialSnapshot', headId: 'cc' } } },
			},
		],
		[
			'the head version is not a number',
			{
				tag: 'Open',
				contents: {
					coordinatedHeadState: {
						version: '3',
						confirmedSnapshot: { snapshot: { version: 3, utxoToCommit: DEPOSIT } },
					},
				},
			},
		],
	])('reports nothing unsettled when %s', (_label, state) => {
		expect(holdsUnsettledCommit(state)).toBe(false);
	});
});

describe('roundSignature', () => {
	it('distinguishes rounds by sequence when the node reports one', () => {
		expect(roundSignature({ tag: 'SeenSnapshot', number: 7 })).not.toBe(
			roundSignature({ tag: 'SeenSnapshot', number: 8 }),
		);
	});

	it('falls back to the tag alone when no sequence is present', () => {
		expect(roundSignature({ tag: 'SeenSnapshot' })).toBe(roundSignature({ tag: 'SeenSnapshot' }));
	});

	it('handles malformed responses without throwing', () => {
		expect(roundSignature(null)).toBe('none');
		expect(roundSignature(undefined)).toBe('none');
		expect(roundSignature({})).toBe('unknown');
	});
});

describe('unwedgeNode', () => {
	it('does nothing when no round is in flight', async () => {
		const opts = options();
		await expect(unwedgeNode(opts)).resolves.toEqual({ kind: 'Healthy' });
		expect(opts.sideLoadSnapshot).not.toHaveBeenCalled();
	});

	// A busy node must not be side-loaded: that would discard in-flight work for
	// no reason.
	it('leaves a round that settles on its own alone', async () => {
		const fetchLastSeen = jest
			.fn<() => Promise<LastSeenSnapshotResponse>>()
			.mockResolvedValueOnce({ tag: 'SeenSnapshot', number: 7 })
			.mockResolvedValueOnce({ tag: 'LastSeenSnapshot', number: 7 });
		const opts = options({ fetchLastSeen });

		expect((await unwedgeNode(opts)).kind).toBe('Progressing');
		expect(opts.sideLoadSnapshot).not.toHaveBeenCalled();
	});

	it('leaves a round that advances to a new sequence alone', async () => {
		const fetchLastSeen = jest
			.fn<() => Promise<LastSeenSnapshotResponse>>()
			.mockResolvedValueOnce({ tag: 'SeenSnapshot', number: 7 })
			.mockResolvedValueOnce({ tag: 'SeenSnapshot', number: 8 });
		const opts = options({ fetchLastSeen });

		expect((await unwedgeNode(opts)).kind).toBe('Progressing');
		expect(opts.sideLoadSnapshot).not.toHaveBeenCalled();
	});

	it('side-loads the confirmed snapshot when the round is stuck', async () => {
		const fetchLastSeen = jest
			.fn<() => Promise<LastSeenSnapshotResponse>>()
			.mockResolvedValueOnce({ tag: 'SeenSnapshot', number: 7 })
			.mockResolvedValueOnce({ tag: 'SeenSnapshot', number: 7 })
			.mockResolvedValue({ tag: 'LastSeenSnapshot', number: 7 });
		const opts = options({ fetchLastSeen });

		expect(await unwedgeNode(opts)).toEqual({ kind: 'Recovered', tag: 'SeenSnapshot' });
		expect(opts.sideLoadSnapshot).toHaveBeenCalledWith({ snapshot: 'confirmed' });
	});

	// The side-load discards the round. If the counterparty already confirmed it,
	// this node ends up a snapshot behind, and the Host cannot see the
	// counterparty's node (its API binds loopback), so by default it leaves the
	// decision to an operator who can.
	describe('without permission to side-load automatically', () => {
		const stuck = () =>
			jest
				.fn<() => Promise<LastSeenSnapshotResponse>>()
				.mockResolvedValueOnce({ tag: 'SeenSnapshot', number: 7 })
				.mockResolvedValueOnce({ tag: 'SeenSnapshot', number: 7 });

		it('leaves a stuck round for an operator and does not touch the node', async () => {
			const opts = options({ fetchLastSeen: stuck(), allowAutoSideLoad: false });

			const outcome = await unwedgeNode(opts);

			expect(outcome).toEqual({
				kind: 'NeedsOperator',
				tag: 'SeenSnapshot',
				reason: expect.stringContaining('HYDRA_HOST_AUTO_SIDELOAD') as unknown as string,
			});
			expect(opts.fetchConfirmedSnapshot).not.toHaveBeenCalled();
			expect(opts.sideLoadSnapshot).not.toHaveBeenCalled();
		});

		it('still waits to be sure the round is stuck before asking for an operator', async () => {
			const fetchLastSeen = jest
				.fn<() => Promise<LastSeenSnapshotResponse>>()
				.mockResolvedValueOnce({ tag: 'SeenSnapshot', number: 7 })
				.mockResolvedValueOnce({ tag: 'LastSeenSnapshot', number: 7 });
			const opts = options({ fetchLastSeen, allowAutoSideLoad: false });

			expect((await unwedgeNode(opts)).kind).toBe('Progressing');
		});
	});

	// Trust nothing: the harness this is ported from explicitly verifies the
	// side-load worked and fails loudly when it did not.
	it('reports unrecovered when the side-load does not clear the round', async () => {
		const fetchLastSeen = jest
			.fn<() => Promise<LastSeenSnapshotResponse>>()
			.mockResolvedValue({ tag: 'SeenSnapshot', number: 7 });
		const opts = options({ fetchLastSeen });

		const outcome = await unwedgeNode(opts);
		expect(outcome.kind).toBe('Unrecovered');
		expect(outcome).toMatchObject({ reason: expect.stringContaining('still stranded') as unknown as string });
	});

	it('reports unrecovered when there is no confirmed snapshot to reset to', async () => {
		const fetchLastSeen = jest
			.fn<() => Promise<LastSeenSnapshotResponse>>()
			.mockResolvedValue({ tag: 'SeenSnapshot', number: 1 });
		const opts = options({
			fetchLastSeen,
			fetchConfirmedSnapshot: jest.fn<() => Promise<unknown>>().mockResolvedValue(null),
		});

		const outcome = await unwedgeNode(opts);
		expect(outcome.kind).toBe('Unrecovered');
		expect(outcome).toMatchObject({ reason: expect.stringContaining('no confirmed snapshot') as unknown as string });
		expect(opts.sideLoadSnapshot).not.toHaveBeenCalled();
	});

	// A side-load clears the node's record of the deposit in flight, and the
	// next deposit can then stall the head again (hydra-node 2.4.1
	// `ReqSnCommitNotSettled`).
	it('leaves a stranded round alone while the confirmed snapshot holds a deposit the chain has not settled', async () => {
		const opts = options({
			fetchLastSeen: jest
				.fn<() => Promise<LastSeenSnapshotResponse>>()
				.mockResolvedValue({ tag: 'SeenSnapshot', number: 7 }),
			fetchHead: jest.fn<() => Promise<unknown>>().mockResolvedValue(headHolding(DEPOSIT, 3)),
		});

		const outcome = await unwedgeNode(opts);
		expect(outcome).toMatchObject({
			kind: 'Held',
			reason: expect.stringContaining('not settled') as unknown as string,
		});
		expect(opts.sideLoadSnapshot).not.toHaveBeenCalled();
	});

	it('reports unrecovered when the head state cannot be read', async () => {
		const opts = options({
			fetchLastSeen: jest
				.fn<() => Promise<LastSeenSnapshotResponse>>()
				.mockResolvedValue({ tag: 'SeenSnapshot', number: 7 }),
			fetchHead: jest.fn<() => Promise<unknown>>().mockRejectedValue(new Error('GET /head returned 503')),
		});

		const outcome = await unwedgeNode(opts);
		expect(outcome).toMatchObject({
			kind: 'Unrecovered',
			reason: expect.stringContaining('returned 503') as unknown as string,
		});
		expect(opts.sideLoadSnapshot).not.toHaveBeenCalled();
	});

	it('reports unrecovered when the side-load is rejected', async () => {
		const fetchLastSeen = jest
			.fn<() => Promise<LastSeenSnapshotResponse>>()
			.mockResolvedValue({ tag: 'SeenSnapshot', number: 1 });
		const opts = options({
			fetchLastSeen,
			sideLoadSnapshot: jest.fn<(s: unknown) => Promise<void>>().mockRejectedValue(new Error('400 Bad Request')),
		});

		const outcome = await unwedgeNode(opts);
		expect(outcome.kind).toBe('Unrecovered');
		expect(outcome).toMatchObject({ reason: expect.stringContaining('rejected') as unknown as string });
	});
});

// An escaping rejection is the worst outcome available here: nothing writes
// `lastStopUndrained`, `Unwedge` outranks the drift watchdog, and the tick's
// per-node catch only logs — so the node replans `Unwedge`, throws, and repeats
// it every tick for good, reading as Running and usable the whole time while its
// drift watchdog is dead.
describe('unwedgeNode read failures', () => {
	const rejecting = () => Promise.reject(new Error('GET /snapshot/last-seen returned 503'));

	it('reports an unreadable first observation instead of throwing', async () => {
		const outcome = await unwedgeNode({
			fetchLastSeen: rejecting,
			fetchConfirmedSnapshot: () => Promise.resolve({}),
			fetchHead: () => Promise.resolve({}),
			sideLoadSnapshot: () => Promise.resolve(),
			allowAutoSideLoad: true,
			settleWaitMs: 0,
			sleep: () => Promise.resolve(),
		});

		expect(outcome.kind).toBe('Unrecovered');
		expect(outcome.kind === 'Unrecovered' && outcome.reason).toContain('returned 503');
	});

	it('reports an unreadable second observation instead of throwing', async () => {
		let call = 0;
		const outcome = await unwedgeNode({
			fetchLastSeen: () => {
				call += 1;
				return call === 1 ? Promise.resolve({ tag: 'SeenSnapshot', snapshotNumber: 4 }) : rejecting();
			},
			fetchConfirmedSnapshot: () => Promise.resolve({}),
			fetchHead: () => Promise.resolve({}),
			sideLoadSnapshot: () => Promise.resolve(),
			allowAutoSideLoad: true,
			settleWaitMs: 0,
			sleep: () => Promise.resolve(),
		});

		expect(outcome.kind).toBe('Unrecovered');
	});

	it('reports an unreadable confirmation after a side-load instead of throwing', async () => {
		let call = 0;
		const outcome = await unwedgeNode({
			fetchLastSeen: () => {
				call += 1;
				return call <= 2 ? Promise.resolve({ tag: 'SeenSnapshot', snapshotNumber: 4 }) : rejecting();
			},
			fetchConfirmedSnapshot: () => Promise.resolve({ snapshotNumber: 4 }),
			fetchHead: () => Promise.resolve({}),
			sideLoadSnapshot: () => Promise.resolve(),
			allowAutoSideLoad: true,
			settleWaitMs: 0,
			sleep: () => Promise.resolve(),
		});

		expect(outcome.kind).toBe('Unrecovered');
		expect(outcome.kind === 'Unrecovered' && outcome.reason).toContain('side-load completed but');
	});
});

// The whole procedure costs ~90s — a read, a 30s settle wait, two more reads
// and a side-load — and it runs inside the tick, holding the node against the
// shutdown's drain. Charged in full against a 240s stop grace it knows nothing
// about, one unwedge is the difference between draining the fleet and being
// SIGKILLed mid-drain.
describe('unwedgeNode during a shutdown', () => {
	it('defers before the side-load when a shutdown begins during the head-state read', async () => {
		let stopping = false;
		const opts = options({
			fetchLastSeen: jest
				.fn<() => Promise<LastSeenSnapshotResponse>>()
				.mockResolvedValue({ tag: 'SeenSnapshot', number: 7 }),
			fetchHead: () => {
				stopping = true;
				return Promise.resolve({ tag: 'Open' });
			},
			isAborted: () => stopping,
		});

		expect(await unwedgeNode(opts)).toEqual({ kind: 'Deferred' });
		expect(opts.sideLoadSnapshot).not.toHaveBeenCalled();
	});

	it('defers before the settle wait, leaving the record untouched', async () => {
		let slept = false;
		const outcome = await unwedgeNode({
			fetchLastSeen: () => Promise.resolve({ tag: 'SeenSnapshot', snapshotNumber: 4 }),
			fetchConfirmedSnapshot: () => Promise.resolve({}),
			fetchHead: () => Promise.resolve({}),
			sideLoadSnapshot: () => Promise.resolve(),
			allowAutoSideLoad: true,
			settleWaitMs: 30_000,
			sleep: () => {
				slept = true;
				return Promise.resolve();
			},
			isAborted: () => true,
		});

		expect(outcome.kind).toBe('Deferred');
		expect(slept).toBe(false);
	});

	it('runs normally when nothing is shutting down', async () => {
		const outcome = await unwedgeNode({
			fetchLastSeen: () => Promise.resolve({ tag: 'LastSeenSnapshot' }),
			fetchConfirmedSnapshot: () => Promise.resolve({}),
			fetchHead: () => Promise.resolve({}),
			sideLoadSnapshot: () => Promise.resolve(),
			allowAutoSideLoad: true,
			settleWaitMs: 0,
			sleep: () => Promise.resolve(),
			isAborted: () => false,
		});

		expect(outcome.kind).toBe('Healthy');
	});
});

describe('unwedgeRecord', () => {
	// `Failed` closes the node's API, and the head could then be neither reset
	// from the payment service nor closed from this side.
	it('keeps a node it leaves stranded running, with its API open', async () => {
		let record = { nodeId: 'node-1', state: 'Running', lastStopUndrained: true, startAttempts: 2 } as NodeRecord;
		const store = {
			update: async (_nodeId: string, mutate: (current: NodeRecord) => NodeRecord) => (record = mutate(record)),
		};
		const client = {
			fetchLastSeen: () => Promise.resolve<LastSeenSnapshotResponse>({ tag: 'SeenSnapshot', number: 7 }),
			fetchConfirmedSnapshot: () => Promise.resolve({ snapshot: 'confirmed' }),
			fetchHead: () => Promise.resolve(headHolding(DEPOSIT, 3)),
			sideLoadSnapshot: jest.fn<(snapshot: unknown) => Promise<void>>().mockResolvedValue(undefined),
		};
		const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };

		await unwedgeRecord(record, 'previous stop could not be drained', {
			client,
			store,
			logger,
			allowAutoSideLoad: true,
			settleWaitMs: 0,
			sleep: noopSleep,
			isAborted: () => false,
		});

		expect(record).toMatchObject({ state: 'Running', lastStopUndrained: false, startAttempts: 0 });
		// Nothing checks the round again, so the API is the only place that shows it.
		expect(record.failureReason).toMatch(/not settled.*\(seen \d{4}-/);
		expect(client.sideLoadSnapshot).not.toHaveBeenCalled();
		expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('left a stranded round alone'));
	});

	// Running for the same reason, but the reason must reach the API: the check
	// does not run again, so nothing else would show that the node waits for an
	// operator.
	it('keeps a node that needs an operator running, and records why and when', async () => {
		let record = { nodeId: 'node-1', state: 'Running', lastStopUndrained: true, startAttempts: 2 } as NodeRecord;
		const store = {
			update: async (_nodeId: string, mutate: (current: NodeRecord) => NodeRecord) => (record = mutate(record)),
		};
		const client = {
			fetchLastSeen: () => Promise.resolve<LastSeenSnapshotResponse>({ tag: 'SeenSnapshot', number: 7 }),
			fetchConfirmedSnapshot: () => Promise.resolve({ snapshot: 'confirmed' }),
			fetchHead: () => Promise.resolve({ tag: 'Open' }),
			sideLoadSnapshot: jest.fn<(snapshot: unknown) => Promise<void>>().mockResolvedValue(undefined),
		};
		const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };

		await unwedgeRecord(record, 'previous stop could not be drained', {
			client,
			store,
			logger,
			allowAutoSideLoad: false,
			settleWaitMs: 0,
			sleep: noopSleep,
			isAborted: () => false,
		});

		expect(record).toMatchObject({ state: 'Running', lastStopUndrained: false, startAttempts: 0 });
		expect(record.failureReason).toMatch(/HYDRA_HOST_AUTO_SIDELOAD.*\(seen \d{4}-/);
		expect(client.sideLoadSnapshot).not.toHaveBeenCalled();
		expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('needs an operator'));
	});
});
