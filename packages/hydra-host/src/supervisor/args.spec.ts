import { describe, expect, it } from '@jest/globals';
import { API_BIND_HOST, LaunchSpecError, buildHydraNodeArgs, type HydraNodeLaunchSpec } from './args.js';

const SPEC: HydraNodeLaunchSpec = {
	nodeId: 'node-abc',
	nodeDir: '/data/nodes/node-abc',
	network: 'preprod',
	apiPort: 4001,
	peerPort: 5001,
	monitoringPort: 6001,
	advertise: 'hydra1.example.com:5001',
	peers: ['hydra2.example.com:5001'],
	peerHydraVerificationKeyFiles: ['/data/nodes/node-abc/peers/0-hydra.vk'],
	peerCardanoVerificationKeyFiles: ['/data/nodes/node-abc/peers/0-cardano.vk'],
	ledgerProtocolParametersFile: '/opt/hydra/params/preprod.json',
	blockfrostProjectFile: '/run/secrets/blockfrost.txt',
	contestationPeriodSeconds: 220,
	depositPeriodSeconds: 300,
	unsyncedPeriodSeconds: 1800,
};

function valueAfter(args: string[], flag: string): string | undefined {
	const index = args.indexOf(flag);
	return index === -1 ? undefined : args[index + 1];
}

describe('buildHydraNodeArgs — security invariants', () => {
	it('always binds the client API to loopback', () => {
		expect(valueAfter(buildHydraNodeArgs(SPEC), '--api-host')).toBe(API_BIND_HOST);
		expect(API_BIND_HOST).toBe('127.0.0.1');
	});

	// hydra-node has no --monitoring-host, so the Prometheus server binds every
	// interface. Omitting the flag is the only way to keep it off a public IP.
	it('omits --monitoring-port when monitoring is not asked for', () => {
		const args = buildHydraNodeArgs({ ...SPEC, monitoringPort: null });
		expect(args).not.toContain('--monitoring-port');
	});

	it('emits --monitoring-port when a port is given', () => {
		expect(valueAfter(buildHydraNodeArgs({ ...SPEC, monitoringPort: 6001 }), '--monitoring-port')).toBe('6001');
	});

	it('binds the peer port on all interfaces while advertising the public address', () => {
		const args = buildHydraNodeArgs(SPEC);
		expect(valueAfter(args, '--listen')).toBe('0.0.0.0:5001');
		expect(valueAfter(args, '--advertise')).toBe('hydra1.example.com:5001');
	});

	it('never enables persistence rotation', () => {
		// The payment service permanently fail-closes a session that emits
		// EventLogRotated, so this flag must never appear.
		expect(buildHydraNodeArgs(SPEC)).not.toContain('--persistence-rotate-after');
	});

	it('uses the etcd baked into the image by default', () => {
		expect(buildHydraNodeArgs(SPEC)).toContain('--use-system-etcd');
		expect(buildHydraNodeArgs({ ...SPEC, useSystemEtcd: false })).not.toContain('--use-system-etcd');
	});
});

describe('buildHydraNodeArgs — composition', () => {
	it('places keys and persistence under the node directory', () => {
		const args = buildHydraNodeArgs(SPEC);
		expect(valueAfter(args, '--hydra-signing-key')).toBe('/data/nodes/node-abc/keys/hydra.sk');
		expect(valueAfter(args, '--cardano-signing-key')).toBe('/data/nodes/node-abc/keys/cardano.sk');
		expect(valueAfter(args, '--persistence-dir')).toBe('/data/nodes/node-abc/persistence');
	});

	it('emits one --peer and one verification key of each kind per peer', () => {
		const twoPeers: HydraNodeLaunchSpec = {
			...SPEC,
			peers: ['a.example.com:5001', 'b.example.com:5001'],
			peerHydraVerificationKeyFiles: ['/k/a-hydra.vk', '/k/b-hydra.vk'],
			peerCardanoVerificationKeyFiles: ['/k/a-cardano.vk', '/k/b-cardano.vk'],
		};
		const args = buildHydraNodeArgs(twoPeers);
		expect(args.filter((a) => a === '--peer')).toHaveLength(2);
		expect(args.filter((a) => a === '--hydra-verification-key')).toHaveLength(2);
		expect(args.filter((a) => a === '--cardano-verification-key')).toHaveLength(2);
	});

	it('formats periods with the seconds suffix hydra-node expects', () => {
		const args = buildHydraNodeArgs(SPEC);
		expect(valueAfter(args, '--contestation-period')).toBe('220s');
		expect(valueAfter(args, '--deposit-period')).toBe('300s');
		expect(valueAfter(args, '--unsynced-period')).toBe('1800s');
	});
});

describe('buildHydraNodeArgs — rejected specs', () => {
	it('refuses to start a node with no peers', () => {
		// --initial-cluster is fixed at boot, so starting before the handshake
		// completes would bootstrap the wrong cluster.
		expect(() => buildHydraNodeArgs({ ...SPEC, peers: [] })).toThrow(/cannot start before its peers are known/);
	});

	it('refuses a peer list containing our own advertise address', () => {
		expect(() => buildHydraNodeArgs({ ...SPEC, peers: [SPEC.advertise] })).toThrow(/its own peer/);
	});

	it('refuses duplicate peers', () => {
		expect(() =>
			buildHydraNodeArgs({
				...SPEC,
				peers: ['a.example.com:5001', 'a.example.com:5001'],
				peerHydraVerificationKeyFiles: ['/k/1.vk', '/k/2.vk'],
				peerCardanoVerificationKeyFiles: ['/k/1.vk', '/k/2.vk'],
			}),
		).toThrow(/duplicates/);
	});

	it('refuses a key count that does not match the peer count', () => {
		expect(() => buildHydraNodeArgs({ ...SPEC, peerHydraVerificationKeyFiles: [] })).toThrow(
			/each peer needs exactly one hydra verification key/,
		);
		expect(() => buildHydraNodeArgs({ ...SPEC, peerCardanoVerificationKeyFiles: [] })).toThrow(
			/each peer needs exactly one cardano verification key/,
		);
	});

	it('refuses malformed advertise and peer addresses', () => {
		expect(() => buildHydraNodeArgs({ ...SPEC, advertise: 'hydra1.example.com' })).toThrow(LaunchSpecError);
		expect(() => buildHydraNodeArgs({ ...SPEC, advertise: 'hydra1.example.com:99999' })).toThrow(/invalid port/);
		expect(() => buildHydraNodeArgs({ ...SPEC, peers: ['nope'] })).toThrow(/peers\[0\]/);
	});

	it('refuses non-positive periods', () => {
		expect(() => buildHydraNodeArgs({ ...SPEC, contestationPeriodSeconds: 0 })).toThrow(/positive whole number/);
	});
});

describe('start-chain-from', () => {
	it('is omitted for a normal start', () => {
		expect(buildHydraNodeArgs(SPEC).join(' ')).not.toContain('--start-chain-from');
	});

	/**
	 * For a node so far behind that replaying the gap costs more than the head
	 * has left — after long downtime over a rate-limited chain backend, catching
	 * up can take days. The node ignores this if its own head state is newer, so
	 * it can only move the starting point forward.
	 */
	it('is passed through when an operator set one', () => {
		const point = '130370414.e364500a42220ea47314215679b7e42e9bbb81fa69d1366fe738d8aef900f7ee';

		expect(buildHydraNodeArgs({ ...SPEC, startChainFrom: point })).toEqual(
			expect.arrayContaining(['--start-chain-from', point]),
		);
	});

	it('is omitted when set to an empty string', () => {
		expect(buildHydraNodeArgs({ ...SPEC, startChainFrom: '' }).join(' ')).not.toContain('--start-chain-from');
	});
});
