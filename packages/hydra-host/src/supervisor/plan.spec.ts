import { describe, expect, it } from '@jest/globals';
import { planNodeAction, type NodeObservation, type PlanLimits } from './plan.js';
import type { NodeRecord } from '../registry/types.js';

const LIMITS: PlanLimits = { maxConsecutiveRestarts: 5, escrowTtlSeconds: 3600 };
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
		peers: [{ advertise: 'hydra2.example.com:5001', hydraVerificationKey: '5820aa', cardanoVkey: 'bb' }],
		contestationPeriodSeconds: 220,
		depositPeriodSeconds: 300,
		unsyncedPeriodSeconds: 1800,
		hydraVerificationKey: '5820cc',
		cardanoVkey: 'dd',
		escrowAckedAt: '2026-07-28T11:00:00.000Z',
		idempotencyKey: 'idem-1',
		createdAt: '2026-07-28T11:00:00.000Z',
		updatedAt: '2026-07-28T11:00:00.000Z',
		restartCount: 0,
		lastStopUndrained: false,
		...overrides,
	};
}

function observe(overrides: Partial<NodeObservation> = {}): NodeObservation {
	return { processRunning: true, drift: 'Healthy', responsive: true, nowMs: NOW, ...overrides };
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

	it('restarts a node whose drift passed the guard', () => {
		const action = planNodeAction(record(), observe({ drift: 'Unsynced' }), LIMITS);
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
		const action = planNodeAction(record({ restartCount: 5 }), observe({ processRunning: false }), LIMITS);
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
