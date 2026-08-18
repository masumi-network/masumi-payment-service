import { describe, expect, it, jest } from '@jest/globals';
import { roundSignature, unwedgeNode, type UnwedgeOptions } from './unwedge.js';
import type { LastSeenSnapshotResponse } from './drain.js';

const noopSleep = async () => undefined;

function options(overrides: Partial<UnwedgeOptions> = {}): UnwedgeOptions {
	return {
		fetchLastSeen: jest.fn<() => Promise<LastSeenSnapshotResponse>>().mockResolvedValue({ tag: 'NoSeenSnapshot' }),
		fetchConfirmedSnapshot: jest.fn<() => Promise<unknown>>().mockResolvedValue({ snapshot: 'confirmed' }),
		sideLoadSnapshot: jest.fn<(snapshot: unknown) => Promise<void>>().mockResolvedValue(undefined),
		settleWaitMs: 30_000,
		sleep: noopSleep,
		...overrides,
	};
}

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
			sideLoadSnapshot: () => Promise.resolve(),
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
			sideLoadSnapshot: () => Promise.resolve(),
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
			sideLoadSnapshot: () => Promise.resolve(),
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
	it('defers before the settle wait, leaving the record untouched', async () => {
		let slept = false;
		const outcome = await unwedgeNode({
			fetchLastSeen: () => Promise.resolve({ tag: 'SeenSnapshot', snapshotNumber: 4 }),
			fetchConfirmedSnapshot: () => Promise.resolve({}),
			sideLoadSnapshot: () => Promise.resolve(),
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
			sideLoadSnapshot: () => Promise.resolve(),
			settleWaitMs: 0,
			sleep: () => Promise.resolve(),
			isAborted: () => false,
		});

		expect(outcome.kind).toBe('Healthy');
	});
});
