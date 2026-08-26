import { describe, expect, it } from '@jest/globals';
import { assertExecutablesAvailable, resolveExecutable, type ExecutableProbe } from './preflight.js';

function probeWith(present: string[], pathValue = '/usr/bin:/opt/bin'): ExecutableProbe {
	return { pathValue, isExecutable: (candidate) => present.includes(candidate) };
}

const NODE_BIN = '/usr/local/bin/hydra-node';

describe('resolveExecutable', () => {
	it('searches PATH in order for a bare name', () => {
		expect(resolveExecutable('etcd', probeWith(['/opt/bin/etcd']))).toBe('/opt/bin/etcd');
		expect(resolveExecutable('etcd', probeWith(['/usr/bin/etcd', '/opt/bin/etcd']))).toBe('/usr/bin/etcd');
	});

	it('returns null when nothing on PATH matches', () => {
		expect(resolveExecutable('etcd', probeWith([]))).toBeNull();
	});

	// Resolving a path-carrying name against PATH would report a different binary
	// as present than the one that will actually run.
	it('never searches PATH for a name that is already a path', () => {
		expect(resolveExecutable(NODE_BIN, probeWith(['/usr/bin/hydra-node']))).toBeNull();
		expect(resolveExecutable(NODE_BIN, probeWith([NODE_BIN]))).toBe(NODE_BIN);
	});

	it('copes with an unset PATH', () => {
		expect(resolveExecutable('etcd', { pathValue: undefined, isExecutable: () => true })).toBeNull();
	});
});

describe('assertExecutablesAvailable', () => {
	it('passes when everything a node needs is there', () => {
		expect(() =>
			assertExecutablesAvailable(
				{ hydraNodeBin: NODE_BIN, useSystemEtcd: true },
				probeWith([NODE_BIN, '/usr/bin/etcd']),
			),
		).not.toThrow();
	});

	it('names HYDRA_NODE_BIN when the binary is missing', () => {
		expect(() => assertExecutablesAvailable({ hydraNodeBin: NODE_BIN, useSystemEtcd: false }, probeWith([]))).toThrow(
			/HYDRA_NODE_BIN/,
		);
	});

	/**
	 * The failure this check exists for: a Host outside the container defaults to
	 * the system etcd, no etcd is installed, and every node dies seconds after
	 * start with the cause in its own log.
	 */
	it('names the override when system etcd is on and no etcd exists', () => {
		expect(() =>
			assertExecutablesAvailable({ hydraNodeBin: NODE_BIN, useSystemEtcd: true }, probeWith([NODE_BIN])),
		).toThrow(/HYDRA_HOST_USE_SYSTEM_ETCD=false/);
	});

	it('does not require etcd when hydra-node extracts its own', () => {
		expect(() =>
			assertExecutablesAvailable({ hydraNodeBin: NODE_BIN, useSystemEtcd: false }, probeWith([NODE_BIN])),
		).not.toThrow();
	});
});
