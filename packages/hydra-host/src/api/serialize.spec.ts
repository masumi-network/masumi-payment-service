/**
 * The guard on the wire is the guard the supervisor enforces.
 *
 * `toPublicNode` resolved the drift thresholds without the host's own override,
 * so with `HYDRA_HOST_DRIFT_GUARD_MS` set the API reported the derived guard
 * while the supervisor was measuring against a different one — the node read as
 * having seconds of headroom left on a guard it had already breached.
 */

import { describe, expect, it } from '@jest/globals';
import { toPublicNode } from './serialize.js';
import type { NodeRecord } from '../registry/types.js';

const NOW = '2026-08-18T12:00:00.000Z';

function record(): NodeRecord {
	return {
		nodeId: 'node-1',
		state: 'Running',
		desired: 'Running',
		network: 'preprod',
		apiPort: 4599,
		peerPort: 5599,
		monitoringPort: 6599,
		advertise: 'hydra1.example.com:5599',
		peers: [],
		contestationPeriodSeconds: 120,
		depositPeriodSeconds: 600,
		unsyncedPeriodSeconds: 300,
		hydraVerificationKey: `5820${'ab'.repeat(32)}`,
		cardanoVerificationKey: `5820${'cd'.repeat(32)}`,
		escrowAckedAt: NOW,
		idempotencyKey: 'idem-1',
		createdAt: NOW,
		updatedAt: NOW,
		startAttempts: 0,
		lastStopUndrained: false,
	};
}

describe('toPublicNode drift guard', () => {
	it('reports the host override rather than the derived guard', () => {
		expect(toPublicNode(record(), { guardMs: 90_000 }).driftGuardSeconds).toBe(90);
	});

	it('falls back to the derived guard when the host sets none', () => {
		const derived = toPublicNode(record()).driftGuardSeconds;

		expect(toPublicNode(record(), undefined).driftGuardSeconds).toBe(derived);
		expect(derived).toBeGreaterThan(0);
	});
});
