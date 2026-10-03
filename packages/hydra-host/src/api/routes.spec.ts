import { describe, expect, it } from '@jest/globals';
import { matchRoute } from './routes.js';

describe('matchRoute', () => {
	it('routes the node lifecycle surface to admin', () => {
		expect(matchRoute('GET', '/v1/nodes')).toEqual({ kind: 'listNodes', tier: 'admin' });
		expect(matchRoute('POST', '/v1/nodes')).toEqual({ kind: 'provisionNode', tier: 'admin' });
		expect(matchRoute('GET', '/v1/capabilities')).toEqual({ kind: 'capabilities', tier: 'admin' });
		expect(matchRoute('GET', '/v1/nodes/abc')).toEqual({ kind: 'getNode', tier: 'admin', nodeId: 'abc' });
		expect(matchRoute('PATCH', '/v1/nodes/abc')).toEqual({ kind: 'setPeers', tier: 'admin', nodeId: 'abc' });
		expect(matchRoute('DELETE', '/v1/nodes/abc')).toEqual({ kind: 'removeNode', tier: 'admin', nodeId: 'abc' });
	});

	it('routes the lifecycle actions to admin', () => {
		for (const [action, kind] of [
			['escrow-ack', 'escrowAck'],
			['start', 'startNode'],
			['stop', 'stopNode'],
			['restart', 'restartNode'],
		] as const) {
			expect(matchRoute('POST', `/v1/nodes/abc/${action}`)).toEqual({ kind, tier: 'admin', nodeId: 'abc' });
		}
	});

	// Health is what the payment service polls to decide if a node is usable, so
	// it is the one route the user tier may read.
	it('routes health to the user tier', () => {
		expect(matchRoute('GET', '/v1/nodes/abc/health')).toEqual({ kind: 'nodeHealth', tier: 'user', nodeId: 'abc' });
	});

	// The control-plane table deliberately owns none of the node API. Those paths
	// fall through to the proxy, which applies its own allow-list — see
	// proxy-path.spec.ts, where /config is asserted unreachable.
	it('leaves the node API to the proxy rather than routing it here', () => {
		expect(matchRoute('GET', '/v1/nodes/abc/config')).toBeNull();
		expect(matchRoute('GET', '/v1/nodes/abc/api')).toBeNull();
		expect(matchRoute('POST', '/v1/nodes/abc/api/snapshot')).toBeNull();
	});

	it('rejects unknown paths, versions and methods', () => {
		expect(matchRoute('GET', '/')).toBeNull();
		expect(matchRoute('GET', '/v2/nodes')).toBeNull();
		expect(matchRoute('GET', '/v1/other')).toBeNull();
		expect(matchRoute('PUT', '/v1/nodes')).toBeNull();
		expect(matchRoute('POST', '/v1/nodes/abc')).toBeNull();
		expect(matchRoute('POST', '/v1/nodes/abc/unknown')).toBeNull();
		expect(matchRoute('GET', '/v1/inbound-invites')).toBeNull();
		expect(matchRoute('DELETE', '/v1/inbound-invites/invite-1')).toBeNull();
		expect(matchRoute('PUT', '/v1/allowed-issuers')).toBeNull();
	});

	it('tolerates trailing and duplicated slashes', () => {
		expect(matchRoute('GET', '/v1/nodes/')).toEqual({ kind: 'listNodes', tier: 'admin' });
		expect(matchRoute('GET', '//v1//nodes//')).toEqual({ kind: 'listNodes', tier: 'admin' });
	});

	// A nodeId is used to build a filesystem path, so anything that could escape
	// the nodes directory must not match a route at all.
	it('refuses a nodeId that is not a plain identifier', () => {
		expect(matchRoute('GET', '/v1/nodes/..')).toBeNull();
		expect(matchRoute('GET', '/v1/nodes/a.b')).toBeNull();
		expect(matchRoute('GET', `/v1/nodes/${'a'.repeat(65)}`)).toBeNull();
	});
});
