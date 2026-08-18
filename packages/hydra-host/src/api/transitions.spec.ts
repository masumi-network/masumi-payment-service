import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { NodeRegistryStore } from '../registry/store.js';
import type { NodeRecord } from '../registry/types.js';
import {
	requestRemoval,
	requestRestart,
	requestStart,
	requestStop,
	assertQuiescentForPeerChange,
} from './transitions.js';

const PEER = {
	advertise: 'hydra2.example.com:5001',
	hydraVerificationKey: `5820${'ab'.repeat(32)}`,
	cardanoVerificationKey: `5820${'cd'.repeat(32)}`,
};

function record(overrides: Partial<NodeRecord> = {}): NodeRecord {
	return {
		nodeId: 'node-1',
		state: 'Stopped',
		desired: 'Stopped',
		network: 'preprod',
		apiPort: 4001,
		peerPort: 5001,
		monitoringPort: 6001,
		advertise: 'hydra1.example.com:5001',
		peers: [PEER],
		contestationPeriodSeconds: 220,
		depositPeriodSeconds: 300,
		unsyncedPeriodSeconds: 1800,
		hydraVerificationKey: '5820aa',
		cardanoVerificationKey: '5820bb',
		escrowAckedAt: '2026-07-28T11:00:00.000Z',
		idempotencyKey: 'idem-1',
		createdAt: '2026-07-28T11:00:00.000Z',
		updatedAt: '2026-07-28T11:00:00.000Z',
		startAttempts: 0,
		lastStopUndrained: false,
		...overrides,
	};
}

let dataDir: string;
let store: NodeRegistryStore;

beforeEach(async () => {
	dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'hydra-host-transitions-'));
	store = new NodeRegistryStore(dataDir);
});

afterEach(async () => {
	await fs.rm(dataDir, { recursive: true, force: true });
});

describe('requestStart', () => {
	it('marks an acknowledged node with peers as wanted running', async () => {
		await store.write(record());
		expect((await requestStart(store, 'node-1')).desired).toBe('Running');
	});

	// An un-acknowledged node may hold the only copy of its keys.
	it('refuses a node that was never escrow-acknowledged', async () => {
		await store.write(record({ escrowAckedAt: null, state: 'PendingEscrow' }));
		await expect(requestStart(store, 'node-1')).rejects.toMatchObject({ status: 409 });
	});

	// --initial-cluster is fixed at boot, so starting before the handshake would
	// bootstrap a cluster the counterparty cannot join.
	it('refuses a node whose peers are not configured', async () => {
		await store.write(record({ peers: [] }));
		await expect(requestStart(store, 'node-1')).rejects.toThrow(/peers must be configured/);
	});

	it('404s an unknown node', async () => {
		await expect(requestStart(store, 'missing')).rejects.toMatchObject({ status: 404 });
	});
});

describe('requestStop', () => {
	it('marks the node as wanted stopped', async () => {
		await store.write(record({ desired: 'Running', state: 'Running' }));
		expect((await requestStop(store, 'node-1')).desired).toBe('Stopped');
	});
});

describe('requestRestart', () => {
	// Setting desired='Running' alone is indistinguishable from steady state for
	// an already-running node, so the request needs its own flag or it is a
	// silent no-op.
	it('flags an explicit restart even when the node is already running', async () => {
		await store.write(record({ state: 'Running', desired: 'Running' }));
		const updated = await requestRestart(store, 'node-1');

		expect(updated.restartRequested).toBe(true);
		expect(updated.desired).toBe('Running');
	});

	it('refuses an un-acknowledged node', async () => {
		await store.write(record({ escrowAckedAt: null, state: 'PendingEscrow' }));
		await expect(requestRestart(store, 'node-1')).rejects.toMatchObject({ status: 409 });
	});
});

describe('requestRemoval', () => {
	// Removal destroys the persistence directory, which is the only copy of the
	// head state on this host.
	it('refuses an acknowledged node without force', async () => {
		await store.write(record());
		await expect(requestRemoval(store, 'node-1', { force: false })).rejects.toMatchObject({ status: 409 });
		await expect(requestRemoval(store, 'node-1', { force: false })).rejects.toThrow(/impossible to close/);
	});

	it('allows an acknowledged node with force', async () => {
		await store.write(record());
		expect((await requestRemoval(store, 'node-1', { force: true })).state).toBe('Removing');
	});

	// A head invite escrows its node's keys the moment it is issued and leaves
	// the node peerless until someone redeems. Without peers there is no
	// --initial-cluster, so the node has never booted and its persistence
	// directory is empty — an unredeemed reservation must stay revocable.
	it('allows removing an acknowledged but peerless node without force', async () => {
		await store.write(record({ peers: [] }));
		expect((await requestRemoval(store, 'node-1', { force: false })).state).toBe('Removing');
	});

	// A node that was never acknowledged never started and holds no head state.
	it('allows removing a never-acknowledged node without force', async () => {
		await store.write(record({ escrowAckedAt: null, state: 'PendingEscrow' }));
		expect((await requestRemoval(store, 'node-1', { force: false })).state).toBe('Removing');
	});
});

describe('assertQuiescentForPeerChange', () => {
	it('permits a peer change while stopped or pending escrow', () => {
		expect(() => assertQuiescentForPeerChange(record({ state: 'Stopped' }))).not.toThrow();
		expect(() => assertQuiescentForPeerChange(record({ state: 'PendingEscrow', escrowAckedAt: null }))).not.toThrow();
	});

	// Changing peers under a running node leaves the process on its old cluster
	// and makes the next restart bootstrap a different, empty one.
	it('refuses a peer change while the node is live', () => {
		for (const state of ['Running', 'Starting', 'Draining', 'Failed'] as const) {
			expect(() => assertQuiescentForPeerChange(record({ state }))).toThrow(expect.objectContaining({ status: 409 }));
		}
	});
});
