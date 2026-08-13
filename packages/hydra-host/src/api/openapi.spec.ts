import { describe, expect, it } from '@jest/globals';
import { DOCUMENTED_OPERATIONS, EXAMPLE_PARAMS, buildOpenApiDocument } from './openapi.js';
import { matchRoute, type RouteKind } from './routes.js';

/**
 * Compile-time exhaustiveness: adding a RouteKind without touching this file
 * fails typecheck here, and the assertions below then demand the new kind be
 * documented. This is what keeps `/openapi.json` honest.
 */
const EVERY_ROUTE_KIND: Record<RouteKind, true> = {
	listNodes: true,
	getNode: true,
	provisionNode: true,
	escrowAck: true,
	setPeers: true,
	startNode: true,
	stopNode: true,
	restartNode: true,
	removeNode: true,
	nodeHealth: true,
	capabilities: true,
	peerAllowlist: true,
	registerInvite: true,
	listInvites: true,
	forgetInvite: true,
};

function concretePath(template: string): string {
	return template.replace('{nodeId}', EXAMPLE_PARAMS.nodeId).replace('{nonce}', EXAMPLE_PARAMS.nonce);
}

describe('the OpenAPI document stays in sync with the route table', () => {
	it('documents every route kind', () => {
		const documented = new Set(DOCUMENTED_OPERATIONS.map((operation) => operation.kind));
		for (const kind of Object.keys(EVERY_ROUTE_KIND)) {
			expect(documented).toContain(kind);
		}
	});

	it.each(DOCUMENTED_OPERATIONS.map((operation) => [operation.method, operation.path, operation] as const))(
		'%s %s resolves through matchRoute to the kind and tier it claims',
		(_method, _path, operation) => {
			const match = matchRoute(operation.method.toUpperCase(), concretePath(operation.path));
			expect(match).not.toBeNull();
			expect(match?.kind).toBe(operation.kind);
			expect(match?.tier).toBe(operation.tier);
		},
	);

	it('builds a document with every path, the proxy, and bearer security', () => {
		const document = buildOpenApiDocument({ network: 'preprod' }) as {
			paths: Record<string, unknown>;
			components: { securitySchemes: Record<string, unknown> };
		};
		for (const operation of DOCUMENTED_OPERATIONS) {
			expect(document.paths[operation.path]).toBeDefined();
		}
		expect(document.paths['/v1/nodes/{nodeId}/api/{subPath}']).toBeDefined();
		expect(document.components.securitySchemes.bearerAuth).toBeDefined();
	});
});
