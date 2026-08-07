import { describe, expect, it } from '@jest/globals';
import { planNodeAction, shouldAdoptAsRunning, type NodeObservation, type PlanLimits } from './plan.js';
import type { NodeRecord } from '../registry/types.js';

const LIMITS: PlanLimits = { maxStartAttempts: 5, escrowTtlSeconds: 3600 };
const NOW = Date.parse('2026-07-28T12:00:00.000Z');

function record(overrides: Partial<NodeRecord> = {}): NodeRecord {
	return {
		nodeId: 'node-1',
		state: 'Running',
		desired: 'Running',
		network: 'preprod',
		apiPort: 4001,
		peerPort: 5001,
		monitoringPort: 6001,
		advertise: 'hydra1.example.com:5001',
		peers: [{ advertise: 'hydra2.example.com:5001', hydraVerificationKey: '5820aa', cardanoVerificationKey: 'bb' }],
		contestationPeriodSeconds: 220,
		depositPeriodSeconds: 300,
		unsyncedPeriodSeconds: 1800,
		hydraVerificationKey: '5820cc',
		cardanoVerificationKey: 'dd',
		escrowAckedAt: '2026-07-28T11:00:00.000Z',
		idempotencyKey: 'idem-1',
		createdAt: '2026-07-28T11:00:00.000Z',
		updatedAt: '2026-07-28T11:00:00.000Z',
		startAttempts: 0,
		lastStopUndrained: false,
		...overrides,
	};
}

function observe(overrides: Partial<NodeObservation> = {}): NodeObservation {
	return {
		processRunning: true,
		drift: 'Healthy',
		driftSeconds: 0,
		responsive: true,
		chainSynced: true,
		nowMs: NOW,
		...overrides,
	};
}

describe('planNodeAction', () => {
	it('idles a healthy running node', () => {
		expect(planNodeAction(record(), observe(), LIMITS)).toEqual({ kind: 'Idle' });
	});

	it('starts a stopped node that is wanted running', () => {
		expect(planNodeAction(record({ state: 'Stopped' }), observe({ processRunning: false }), LIMITS)).toEqual({
			kind: 'Start',
		});
	});

	it('stops a running node that is wanted stopped', () => {
		expect(planNodeAction(record({ desired: 'Stopped' }), observe(), LIMITS).kind).toBe('Stop');
	});

	// An unacknowledged node may hold the only copy of its keys, so it must never
	// be started — but it must not linger either.
	it('never starts a node pending escrow, and reaps it once the TTL passes', () => {
		const pending = record({ state: 'PendingEscrow', escrowAckedAt: null });
		expect(planNodeAction(pending, observe({ processRunning: false }), LIMITS)).toEqual({ kind: 'Idle' });

		const expired = planNodeAction(pending, observe({ nowMs: NOW + 2 * 3600 * 1000, processRunning: false }), LIMITS);
		expect(expired.kind).toBe('Remove');
	});

	// --initial-cluster is fixed at boot, so a node started before the handshake
	// would bootstrap a cluster its counterparty cannot join.
	it('refuses to start a node whose peers are not yet known', () => {
		expect(planNodeAction(record({ peers: [] }), observe({ processRunning: false }), LIMITS)).toEqual({
			kind: 'Idle',
		});
	});

	it('restarts a node that has been past the guard without closing the gap', () => {
		const stuck = record({ driftBreachSince: new Date(NOW - 5 * 60_000).toISOString(), driftBreachSeconds: 400 });
		const action = planNodeAction(stuck, observe({ drift: 'Unsynced', driftSeconds: 400 }), LIMITS);
		expect(action.kind).toBe('Restart');
	});

	it('leaves a merely degraded node running', () => {
		expect(planNodeAction(record(), observe({ drift: 'Degraded' }), LIMITS)).toEqual({ kind: 'Idle' });
	});

	it('waits for a starting node to become responsive before judging it', () => {
		expect(planNodeAction(record(), observe({ responsive: false, drift: null }), LIMITS)).toEqual({ kind: 'Idle' });
	});

	// An undrained stop may have stranded a round; that must be checked before
	// drift, since a wedged node also stops advancing its chain view.
	it('checks for a stranded round after an undrained stop, ahead of drift', () => {
		const action = planNodeAction(record({ lastStopUndrained: true }), observe({ drift: 'Unsynced' }), LIMITS);
		expect(action.kind).toBe('Unwedge');
	});

	// A node that cannot stay up is a config or chain problem; looping restarts
	// would hide it and keep the head unusable.
	it('fails a node that exhausted its restart budget instead of looping', () => {
		const action = planNodeAction(record({ startAttempts: 5 }), observe({ processRunning: false }), LIMITS);
		expect(action.kind).toBe('Fail');
		expect(action).toMatchObject({ reason: expect.stringContaining('5 attempts') as unknown as string });
	});

	it('keeps a failed node terminal until an operator intervenes', () => {
		expect(planNodeAction(record({ state: 'Failed' }), observe({ processRunning: false }), LIMITS)).toEqual({
			kind: 'Idle',
		});
	});

	it('prioritises removal over every other consideration', () => {
		const action = planNodeAction(
			record({ state: 'Removing', desired: 'Running' }),
			observe({ drift: 'Unsynced' }),
			LIMITS,
		);
		expect(action.kind).toBe('Remove');
	});
});

/**
 * A host is an ordinary process and its nodes outlive it, so a restart used to
 * leave a live node recorded as Stopped with nothing ever reconsidering it: the
 * payment service read that state and refused to connect to a healthy node.
 *
 * Repairing it has to stop short of overriding intent, which is the part worth
 * pinning — a drain, a failure and a teardown all look like "not Running" while
 * a port still answers.
 */
describe('shouldAdoptAsRunning', () => {
	const record = (state: NodeRecord['state'], desired: NodeRecord['desired']) => ({ state, desired });

	it('adopts a responsive node the record calls stopped', () => {
		expect(shouldAdoptAsRunning(record('Stopped', 'Running'), { responsive: true })).toBe(true);
	});

	it('adopts a responsive node that is still starting', () => {
		expect(shouldAdoptAsRunning(record('Starting', 'Running'), { responsive: true })).toBe(true);
	});

	it('never adopts a node that is not answering', () => {
		expect(shouldAdoptAsRunning(record('Stopped', 'Running'), { responsive: false })).toBe(false);
	});

	// A draining node answers for a while. Calling it Running would hand the
	// payment service a node it is about to lose.
	it('leaves a node alone while it is being drained', () => {
		expect(shouldAdoptAsRunning(record('Stopped', 'Stopped'), { responsive: true })).toBe(false);
		expect(shouldAdoptAsRunning(record('Starting', 'Stopped'), { responsive: true })).toBe(false);
	});

	// Failed is terminal until an operator looks at it; adopting it would hide
	// the failure it exists to surface.
	it('never resurrects a failed node', () => {
		expect(shouldAdoptAsRunning(record('Failed', 'Running'), { responsive: true })).toBe(false);
	});

	// PendingEscrow gates key-material readability and Removing is a teardown.
	// Neither means "in service" just because a port answers.
	it('never adopts a node that was never put into service', () => {
		expect(shouldAdoptAsRunning(record('PendingEscrow', 'Running'), { responsive: true })).toBe(false);
		expect(shouldAdoptAsRunning(record('Removing', 'Running'), { responsive: true })).toBe(false);
	});
});

/**
 * A node that is behind is not automatically a node that is broken.
 *
 * With the Blockfrost backend, being behind is the normal state on the way up:
 * the follower's delay-free catch-up runs at startup and closes the gap at
 * roughly a block a second. Restarting it mid-catch-up throws that progress
 * away and starts it again from the same checkpoint, so it never finishes.
 *
 * What cannot fix itself is being behind and STANDING STILL, which is where the
 * same node ends up once catch-up has run: from then on it sleeps an average
 * block time before every block and can only track the tip. Only a restart
 * re-runs the catch-up, so the plan waits for a stall rather than a verdict.
 */
describe('planNodeAction while the node is behind', () => {
	it('leaves a node that is closing the gap alone, however far behind it is', () => {
		// No breach recorded: driftBreachFields re-anchors on every improvement,
		// so a node making progress never presents one.
		const action = planNodeAction(record(), observe({ chainSynced: false, drift: 'Unsynced', driftSeconds: 54_700 }), LIMITS);

		expect(action.kind).not.toBe('Restart');
	});

	it('leaves a node alone whose breach is younger than the stall window', () => {
		const fresh = record({ driftBreachSince: new Date(NOW - 30_000).toISOString(), driftBreachSeconds: 400 });
		const action = planNodeAction(fresh, observe({ drift: 'Unsynced', driftSeconds: 400 }), LIMITS);

		expect(action.kind).not.toBe('Restart');
	});

	// The case the guard was written for, and the one that stranded three heads:
	// a follower stuck behind, reporting "catching up" forever.
	it('restarts a node stuck behind the tip even while it reports catching up', () => {
		const stuck = record({ driftBreachSince: new Date(NOW - 5 * 60_000).toISOString(), driftBreachSeconds: 400 });
		const action = planNodeAction(stuck, observe({ chainSynced: false, drift: 'Unsynced', driftSeconds: 402 }), LIMITS);

		expect(action.kind).toBe('Restart');
	});

	it('does not restart again inside the cooldown', () => {
		const stuck = record({
			driftBreachSince: new Date(NOW - 5 * 60_000).toISOString(),
			driftBreachSeconds: 400,
			lastDriftRestartAt: new Date(NOW - 60_000).toISOString(),
		});
		const action = planNodeAction(stuck, observe({ drift: 'Unsynced', driftSeconds: 402 }), LIMITS);

		expect(action.kind).not.toBe('Restart');
	});
});
