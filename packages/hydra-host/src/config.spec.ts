import { describe, expect, it } from '@jest/globals';
import { ConfigError, advertiseAddress, loadHostConfig, type EnvSource } from './config.js';

const TOKEN_A = 'a'.repeat(40);
const TOKEN_B = 'b'.repeat(40);

function env(overrides: Record<string, string> = {}): EnvSource {
	const values = new Map<string, string>(
		Object.entries({
			HYDRA_HOST_PUBLIC_HOST: 'hydra1.example.com',
			HYDRA_HOST_ADMIN_TOKEN: TOKEN_A,
			HYDRA_HOST_USER_TOKEN: TOKEN_B,
			...overrides,
		}),
	);
	return { get: (key) => values.get(key) };
}

describe('loadHostConfig', () => {
	it('builds a usable config from the minimum required env', () => {
		const config = loadHostConfig(env());
		expect(config.publicHost).toBe('hydra1.example.com');
		expect(config.network).toBe('preprod');
		expect(config.ports.capacity).toBe(32);
		expect(config.listenPort).toBe(8443);
	});

	it('requires the public host, since it becomes every node advertise address', () => {
		const values = env();
		expect(() => loadHostConfig({ get: (k) => (k === 'HYDRA_HOST_PUBLIC_HOST' ? undefined : values.get(k)) })).toThrow(
			/HYDRA_HOST_PUBLIC_HOST is required/,
		);
	});

	// The advertise string must be a bare host:port; a scheme or path here would
	// produce an address the counterparty's etcd cannot dial.
	it('rejects a public host carrying a scheme, port or path', () => {
		for (const bad of ['https://hydra1.example.com', 'hydra1.example.com:5001', 'hydra1.example.com/api']) {
			expect(() => loadHostConfig(env({ HYDRA_HOST_PUBLIC_HOST: bad }))).toThrow(/bare hostname or IP/);
		}
	});

	it('rejects an unknown network', () => {
		expect(() => loadHostConfig(env({ HYDRA_HOST_NETWORK: 'preview' }))).toThrow(ConfigError);
	});

	// The tokens are the only thing in front of an API that can close a head.
	it('rejects identical or short tokens', () => {
		expect(() => loadHostConfig(env({ HYDRA_HOST_USER_TOKEN: TOKEN_A }))).toThrow(/must differ/);
		expect(() => loadHostConfig(env({ HYDRA_HOST_ADMIN_TOKEN: 'short' }))).toThrow(/at least 32 characters/);
	});

	it('rejects a port layout whose ranges would collide', () => {
		expect(() => loadHostConfig(env({ HYDRA_HOST_PEER_PORT_COUNT: '2000' }))).toThrow(/overlaps/);
	});

	// Thresholds are no longer validated here, because the value a guard must
	// stay below is per NODE — signed into the invite that opened its head —
	// while this config is per host. The host cannot know it, so it carries an
	// override and `resolveDriftThresholds` decides per node, discarding one
	// that could never fire in time.
	it('carries drift thresholds as an override rather than a default', () => {
		expect(loadHostConfig(env()).drift).toEqual({});
		expect(loadHostConfig(env({ HYDRA_HOST_DRIFT_GUARD_MS: '90000' })).drift).toEqual({ guardMs: 90_000 });
	});

	it('accepts a guard that could never fire, leaving it for the node to discard', () => {
		expect(loadHostConfig(env({ HYDRA_HOST_DRIFT_GUARD_MS: '1800000' })).drift).toEqual({ guardMs: 1_800_000 });
	});

	it('rejects a non-numeric override', () => {
		expect(() => loadHostConfig(env({ HYDRA_HOST_PORT: 'eight-thousand' }))).toThrow(/whole number/);
	});

	it('defaults the ledger params file per network', () => {
		expect(loadHostConfig(env()).ledgerProtocolParametersFile).toBe('/opt/hydra/params/preprod.json');
		expect(loadHostConfig(env({ HYDRA_HOST_NETWORK: 'mainnet' })).ledgerProtocolParametersFile).toBe(
			'/opt/hydra/params/mainnet.json',
		);
	});
});

describe('advertiseAddress', () => {
	it('joins the public host to the allocated peer port', () => {
		expect(advertiseAddress(loadHostConfig(env()), 5007)).toBe('hydra1.example.com:5007');
	});
});

describe('numbers that must be above zero', () => {
	// Zero is the natural spelling of "turn this off", and for these two it is
	// the opposite: a zero TTL reaps every node on the tick after it is
	// provisioned, keys and directory included, before escrow-ack can arrive.
	it.each(['HYDRA_HOST_ESCROW_TTL_SECONDS', 'HYDRA_HOST_DRAIN_TIMEOUT_MS'])('refuses %s of zero', (key) => {
		expect(() => loadHostConfig(env({ [key]: '0' }))).toThrow(ConfigError);
		expect(() => loadHostConfig(env({ [key]: '-1' }))).toThrow(ConfigError);
	});

	it('still accepts a positive one', () => {
		const config = loadHostConfig(env({ HYDRA_HOST_ESCROW_TTL_SECONDS: '60', HYDRA_HOST_DRAIN_TIMEOUT_MS: '1000' }));

		expect(config.escrowTtlSeconds).toBe(60);
		expect(config.drainTimeoutMs).toBe(1000);
	});
});
