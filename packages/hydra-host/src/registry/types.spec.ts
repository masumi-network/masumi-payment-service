import { describe, expect, it } from '@jest/globals';
import { canStart, isKeyMaterialReadable, isUsable, restartCountOf, type NodeRecord } from './types.js';

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
		escrowAckedAt: '2026-07-30T11:00:00.000Z',
		idempotencyKey: 'idem-1',
		createdAt: '2026-07-30T11:00:00.000Z',
		updatedAt: '2026-07-30T11:00:00.000Z',
		startAttempts: 0,
		lastStopUndrained: false,
		...overrides,
	};
}

function observed(responsive: boolean, chainSynced = responsive): NodeRecord['lastObservation'] {
	return {
		checkedAt: '2026-07-30T11:05:00.000Z',
		responsive,
		chainSynced,
		drift: chainSynced ? 'Healthy' : null,
	};
}

describe('restartCountOf', () => {
	it('reports no restarts for a node that has never been started', () => {
		expect(restartCountOf(record({ startAttempts: 0 }))).toBe(0);
	});

	it('reports no restarts for a node that came up on its first attempt', () => {
		// The counter is incremented before the spawn, so a healthy node that has
		// been started exactly once holds 1 — reporting that as a restart would
		// tell an operator a node had failed when it had not.
		expect(restartCountOf(record({ startAttempts: 1 }))).toBe(0);
	});

	it('counts the attempts beyond the first as restarts', () => {
		expect(restartCountOf(record({ startAttempts: 4 }))).toBe(3);
	});
});

describe('isUsable', () => {
	it('is false while the node is still starting', () => {
		expect(isUsable(record({ state: 'Starting', lastObservation: observed(false) }))).toBe(false);
	});

	it('is false for a Running node whose API has stopped answering', () => {
		// The whole point of persisting the probe: the record says Running, but
		// routing work here would fail.
		expect(isUsable(record({ state: 'Running', lastObservation: observed(false) }))).toBe(false);
	});

	it('is false before the node has ever been probed', () => {
		expect(isUsable(record({ state: 'Running', lastObservation: undefined }))).toBe(false);
	});

	it('is false for a Running node that answers but is still catching up', () => {
		// It accepts the connection and then refuses every command with
		// WaitOnNodeInSync, so reporting it usable sends work somewhere it cannot
		// be done.
		expect(isUsable(record({ state: 'Running', lastObservation: observed(true, false) }))).toBe(false);
	});

	it('is true for a Running node that answered its last probe and is synced', () => {
		expect(isUsable(record({ state: 'Running', lastObservation: observed(true) }))).toBe(true);
	});
});

describe('canStart', () => {
	it('refuses a node with no peers', () => {
		expect(canStart(record({ peers: [] }))).toBe(false);
	});

	it('refuses a node that has not been escrow-acknowledged', () => {
		expect(canStart(record({ escrowAckedAt: null }))).toBe(false);
	});

	it('allows an acknowledged node with peers', () => {
		expect(canStart(record())).toBe(true);
	});
});

describe('isKeyMaterialReadable', () => {
	it('is readable only before acknowledgement', () => {
		expect(isKeyMaterialReadable(record({ state: 'PendingEscrow', escrowAckedAt: null }))).toBe(true);
		expect(isKeyMaterialReadable(record({ state: 'PendingEscrow' }))).toBe(false);
		expect(isKeyMaterialReadable(record({ state: 'Running', escrowAckedAt: null }))).toBe(false);
	});
});
