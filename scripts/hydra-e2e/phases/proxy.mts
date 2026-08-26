/**
 * The proxy allow-list, checked against live nodes.
 *
 * hydra-node has no authentication, so this allow-list is the whole boundary.
 * The negative cases matter more than the positive ones: `GET /config`
 * discloses the signing-key paths and the persistence directory, and it must be
 * unreachable *by construction* rather than by anyone remembering to block it.
 */

import { check, equals, phase } from '../check.mjs';
import { http } from '../procs.mjs';
import { collectEvents } from './cluster.mjs';
import type { NodeHandle } from './provision.mjs';

function apiUrl(node: NodeHandle, subPath: string): string {
	return `${node.host.spec.baseUrl}/v1/nodes/${node.nodeId}/api${subPath}`;
}

export async function checkProxyAllowList(nodes: NodeHandle[]): Promise<void> {
	phase('proxy: allow-list');
	const node = nodes[0];
	const user = node.host.spec.userToken;

	// Allowed, and genuinely served by the node rather than synthesised here.
	const params = await http(apiUrl(node, '/protocol-parameters'), { token: user });
	equals('GET /protocol-parameters is allowed', params.status, 200);
	const paramsBody = (params.body ?? {}) as Record<string, unknown>;
	check(
		'protocol parameters came from the running node',
		Object.keys(paramsBody).length > 5,
		`${Object.keys(paramsBody).length} fields`,
	);

	const lastSeen = await http(apiUrl(node, '/snapshot/last-seen'), { token: user });
	equals('GET /snapshot/last-seen is allowed', lastSeen.status, 200);
	check(
		'last-seen reports a drainable snapshot state',
		typeof (lastSeen.body as { tag?: string } | null)?.tag === 'string',
		JSON.stringify(lastSeen.body),
	);

	const commits = await http(apiUrl(node, '/commits'), { token: user });
	check('GET /commits is allowed', commits.status === 200, `status ${commits.status}`);

	// Refused.
	const cases: Array<{ label: string; subPath: string; method?: string; token?: string; expect: number }> = [
		{ label: 'GET /config is not routable', subPath: '/config', token: user, expect: 404 },
		{ label: 'GET /protocol-parameters without a token is refused', subPath: '/protocol-parameters', expect: 401 },
		{
			label: 'GET /protocol-parameters with a wrong token is refused',
			subPath: '/protocol-parameters',
			token: 'wrong-token-wrong-token-wrong-tok',
			expect: 401,
		},
		{ label: 'an unknown node API path is not routable', subPath: '/anything', token: user, expect: 404 },
		{
			label: 'DELETE of a non-commit path is not routable',
			subPath: '/snapshot',
			method: 'DELETE',
			token: user,
			expect: 404,
		},
	];

	for (const testCase of cases) {
		const result = await http(apiUrl(node, testCase.subPath), { method: testCase.method, token: testCase.token });
		equals(testCase.label, result.status, testCase.expect);
	}

	// The admin token is for fleet management; node operation is the user tier.
	// Both are legitimate holders, so this checks routing, not exclusion.
	const asAdmin = await http(apiUrl(node, '/protocol-parameters'), { token: node.host.spec.adminToken });
	check('the admin token also reaches the node API', asAdmin.status === 200, `status ${asAdmin.status}`);

	// A node id that exists on the other Host must not resolve here.
	const foreign = await http(`${node.host.spec.baseUrl}/v1/nodes/${nodes[1].nodeId}/api/protocol-parameters`, {
		token: user,
	});
	check('a node id belonging to the other host is not served', foreign.status === 404, `status ${foreign.status}`);
}

export async function checkProxyWebSocket(nodes: NodeHandle[]): Promise<void> {
	phase('proxy: websocket');
	const node = nodes[0];

	const authorised = await collectEvents(node, { durationMs: 8_000 });
	check(
		'the WebSocket upgrade succeeds with the user token',
		authorised.error === null && authorised.messages.length > 0,
		authorised.error ?? `${authorised.messages.length} messages`,
	);

	const unauthorised = await collectEvents(node, { durationMs: 5_000, token: 'nope-nope-nope-nope-nope-nope-nop' });
	check(
		'the WebSocket upgrade is refused without a valid token',
		unauthorised.messages.length === 0,
		unauthorised.error ?? `received ${unauthorised.messages.length} messages`,
	);
}
