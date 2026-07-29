import { describe, expect, it } from '@jest/globals';
import { isProxyableHttpPath, isProxyableWebSocketPath, matchNodeApiProxy } from './proxy-path.js';

describe('matchNodeApiProxy', () => {
	it('splits the node id from the sub-path', () => {
		expect(matchNodeApiProxy('/v1/nodes/abc/api/snapshot/utxo')).toEqual({ nodeId: 'abc', subPath: '/snapshot/utxo' });
		expect(matchNodeApiProxy('/v1/nodes/abc/api')).toEqual({ nodeId: 'abc', subPath: '/' });
	});

	it('ignores anything that is not a node-api request', () => {
		expect(matchNodeApiProxy('/v1/nodes/abc')).toBeNull();
		expect(matchNodeApiProxy('/v1/nodes/abc/health')).toBeNull();
		expect(matchNodeApiProxy('/v1/capabilities')).toBeNull();
		expect(matchNodeApiProxy('/')).toBeNull();
	});

	// The sub-path is forwarded and the node id selects a record, so neither may
	// be an arbitrary string.
	it('refuses a node id that is not a plain identifier', () => {
		expect(matchNodeApiProxy('/v1/nodes/../api/head')).toBeNull();
		expect(matchNodeApiProxy('/v1/nodes/a.b/api/head')).toBeNull();
	});
});

describe('isProxyableHttpPath', () => {
	it('permits the read surface the payment service uses', () => {
		for (const path of ['/head', '/snapshot', '/snapshot/utxo', '/snapshot/last-seen', '/commits', '/protocol-parameters']) {
			expect(isProxyableHttpPath('GET', path)).toBe(true);
		}
	});

	it('permits the state-changing surface the payment service uses', () => {
		for (const path of ['/snapshot', '/commit', '/decommit', '/transaction', '/cardano-transaction']) {
			expect(isProxyableHttpPath('POST', path)).toBe(true);
		}
	});

	it('permits deposit recovery only for a well-formed tx id', () => {
		expect(isProxyableHttpPath('DELETE', `/commits/${'a'.repeat(64)}`)).toBe(true);
		expect(isProxyableHttpPath('DELETE', '/commits/short')).toBe(false);
		expect(isProxyableHttpPath('DELETE', '/commits')).toBe(false);
	});

	// GET /config discloses signing-key paths and the persistence directory. It
	// must be unreachable, and the allow-list is what guarantees that rather than
	// anyone remembering to deny it.
	it('blocks /config', () => {
		expect(isProxyableHttpPath('GET', '/config')).toBe(false);
	});

	// An allow-list means a path hydra adds later is refused by default.
	it('blocks unknown paths and mismatched methods', () => {
		expect(isProxyableHttpPath('GET', '/some-future-endpoint')).toBe(false);
		expect(isProxyableHttpPath('POST', '/head')).toBe(false);
		expect(isProxyableHttpPath('GET', '/commit')).toBe(false);
		expect(isProxyableHttpPath('PUT', '/snapshot')).toBe(false);
		expect(isProxyableHttpPath('GET', '/')).toBe(false);
	});
});

describe('isProxyableWebSocketPath', () => {
	it('permits only the node api root', () => {
		expect(isProxyableWebSocketPath('/')).toBe(true);
		expect(isProxyableWebSocketPath('/config')).toBe(false);
		expect(isProxyableWebSocketPath('/snapshot')).toBe(false);
	});
});
