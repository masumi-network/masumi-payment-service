/**
 * An invite may only name a node that will still be there to redeem.
 *
 * The existence check reasoned that registering against a node that does not
 * exist means the counterparty publishes their material, is told the redemption
 * succeeded, and the start then fails on a nonce that can never be used again.
 * A node that has not been escrow-acknowledged reaches the same end: it sits in
 * `PendingEscrow`, and the supervisor removes one whose escrow TTL has passed —
 * an hour by default, against an invite this host will hold for thirty days.
 */

import { describe, expect, it, jest } from '@jest/globals';
import { registerInvite } from './exchange-admin.js';
import { ProvisionError } from './provision.js';
import type { ExchangeStore } from '../registry/exchange-store.js';
import type { NodeRegistryStore } from '../registry/store.js';
import type { NodeRecord } from '../registry/types.js';

const NOW = '2026-08-19T12:00:00.000Z';

function node(overrides: Partial<NodeRecord> = {}): NodeRecord {
	return {
		nodeId: 'node-1',
		state: 'Stopped',
		desired: 'Running',
		network: 'preprod',
		apiPort: 4001,
		peerPort: 5001,
		monitoringPort: 6001,
		advertise: 'hydra1.example.com:5001',
		peers: [],
		contestationPeriodSeconds: 220,
		depositPeriodSeconds: 300,
		unsyncedPeriodSeconds: 1800,
		hydraVerificationKey: `5820${'ab'.repeat(32)}`,
		cardanoVerificationKey: `5820${'cd'.repeat(32)}`,
		escrowAckedAt: NOW,
		idempotencyKey: 'idem-1',
		createdAt: NOW,
		updatedAt: NOW,
		startAttempts: 0,
		lastStopUndrained: false,
		...overrides,
	};
}

function stores(record: NodeRecord | null) {
	const register = jest.fn(async () => undefined);
	return {
		exchange: { registerInvite: register } as unknown as ExchangeStore,
		nodes: { read: async () => record } as unknown as NodeRegistryStore,
		register,
	};
}

const body = { nonce: 'nonce-one', hostNodeId: 'node-1', expiresAt: Date.now() + 60_000 };

describe('registerInvite', () => {
	it('reserves an acknowledged node', async () => {
		const { exchange, nodes, register } = stores(node());

		await expect(registerInvite(exchange, nodes, body)).resolves.toEqual({ nonce: 'nonce-one' });
		expect(register).toHaveBeenCalled();
	});

	it('refuses a node that does not exist', async () => {
		const { exchange, nodes, register } = stores(null);

		await expect(registerInvite(exchange, nodes, body)).rejects.toMatchObject({ status: 404 });
		expect(register).not.toHaveBeenCalled();
	});

	// The reaper takes it an hour in; the invite would have been valid for thirty
	// days, and the nonce is burned before the node is touched.
	it('refuses a node the escrow reaper can still delete', async () => {
		const { exchange, nodes, register } = stores(node({ state: 'PendingEscrow', escrowAckedAt: null }));

		const refusal = registerInvite(exchange, nodes, body);
		await expect(refusal).rejects.toBeInstanceOf(ProvisionError);
		await expect(refusal).rejects.toMatchObject({ status: 409 });
		expect(register).not.toHaveBeenCalled();
	});
});
