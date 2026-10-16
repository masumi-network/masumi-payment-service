import { describe, expect, it, jest } from '@jest/globals';
import { loadHostConfig, type EnvSource } from '../config.js';
import type { PeerTargetCheck } from '../peer-target-policy.js';
import type { NodeRecord } from '../registry/types.js';
import { buildLaunchArgs, checkStoredPeers } from './launch.js';

const env: EnvSource = {
	get: (key) =>
		({
			HYDRA_HOST_PUBLIC_HOST: 'hydra1.example.com',
			HYDRA_HOST_PUBLIC_EXCHANGE_URL: 'https://exchange.hydra1.example.com:8444/exchange',
			HYDRA_HOST_ADMIN_TOKEN: 'a'.repeat(40),
			HYDRA_HOST_USER_TOKEN: 'u'.repeat(40),
		})[key],
};
const config = loadHostConfig(env);

function makeRecord(advertises: string[]): NodeRecord {
	const now = new Date().toISOString();
	return {
		nodeId: 'node-1',
		state: 'Stopped',
		desired: 'Running',
		network: 'preprod',
		apiPort: 4001,
		peerPort: 5001,
		monitoringPort: 6001,
		advertise: 'hydra1.example.com:5001',
		peers: advertises.map((advertise) => ({
			advertise,
			hydraVerificationKey: `5820${'ef'.repeat(32)}`,
			cardanoVerificationKey: `5820${'12'.repeat(32)}`,
		})),
		contestationPeriodSeconds: 120,
		depositPeriodSeconds: 600,
		depositActivationSeconds: 600,
		unsyncedPeriodSeconds: 300,
		hydraVerificationKey: `5820${'ab'.repeat(32)}`,
		cardanoVerificationKey: `5820${'cd'.repeat(32)}`,
		escrowAckedAt: now,
		idempotencyKey: 'idem-1',
		createdAt: now,
		updatedAt: now,
		startAttempts: 1,
		lastStopUndrained: false,
	};
}

describe('buildLaunchArgs', () => {
	it('passes every stored peer as --peer', () => {
		const args = buildLaunchArgs(
			config,
			'/data/nodes/node-1',
			makeRecord(['hydra2.example.com:5001', 'hydra3.example.com:5001']),
		);

		expect(args.filter((_, i) => args[i - 1] === '--peer')).toEqual([
			'hydra2.example.com:5001',
			'hydra3.example.com:5001',
		]);
	});
});

describe('checkStoredPeers', () => {
	it('checks every stored peer and allows them when the policy does', async () => {
		const check = jest.fn<PeerTargetCheck>(async () => null);

		expect(
			await checkStoredPeers(makeRecord(['hydra2.example.com:5001', 'hydra3.example.com:5001']), check),
		).toBeNull();
		expect(check.mock.calls).toEqual([['hydra2.example.com:5001'], ['hydra3.example.com:5001']]);
	});

	// A record stored before the policy existed must not keep dialling a
	// private address on every restart.
	it('returns the first stored peer the policy refuses', async () => {
		const check: PeerTargetCheck = async (advertise) =>
			advertise.startsWith('127.') ? { reason: 'non-public address 127.0.0.1', transient: false } : null;

		expect(await checkStoredPeers(makeRecord(['hydra2.example.com:5001', '127.0.0.1:8443']), check)).toEqual({
			reason: 'non-public address 127.0.0.1',
			transient: false,
		});
	});
});
