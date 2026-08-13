/**
 * The control plane's OpenAPI document, generated from one table that mirrors
 * `routes.ts`. The pairing is enforced by `openapi.spec.ts`: every documented
 * operation must resolve through `matchRoute` to the kind and tier it claims,
 * and every `RouteKind` must be documented — so the spec cannot silently
 * drift from the router.
 *
 * Shapes are deliberately coarse. The authoritative request/response types
 * live in the handlers (`provision.ts`, `server.ts`, `serialize.ts`); this
 * document tells an operator what exists, which token tier it needs, and
 * where to look — it does not duplicate every field.
 */

import type { RouteKind } from './routes.js';

export type DocumentedOperation = {
	/** Path template as documented (`{nodeId}` / `{nonce}` placeholders). */
	path: string;
	method: 'get' | 'post' | 'patch' | 'delete';
	kind: RouteKind;
	tier: 'admin' | 'user';
	summary: string;
	description?: string;
};

/** Concrete substitutions the sync test uses to exercise `matchRoute`. */
export const EXAMPLE_PARAMS = { nodeId: 'node-1', nonce: 'nonce-12345678' } as const;

export const DOCUMENTED_OPERATIONS: readonly DocumentedOperation[] = [
	{
		path: '/v1/capabilities',
		method: 'get',
		kind: 'capabilities',
		tier: 'admin',
		summary: 'What this Host can run',
		description: 'Hydra version, script catalogue and ledger-params hashes, network, and free node slots.',
	},
	{
		path: '/v1/peer-allowlist',
		method: 'get',
		kind: 'peerAllowlist',
		tier: 'admin',
		summary: 'Peer-port firewall allowlist',
		description:
			'Every head peer port and the counterparty addresses allowed to reach it, plus rendered nftables rules.',
	},
	{
		path: '/v1/invites',
		method: 'post',
		kind: 'registerInvite',
		tier: 'admin',
		summary: 'Register a head invite for the Exchange Plane to honour',
	},
	{
		path: '/v1/invites',
		method: 'get',
		kind: 'listInvites',
		tier: 'admin',
		summary: 'List invites, with a redeemedSince watermark for polling',
	},
	{
		path: '/v1/invites/{nonce}',
		method: 'delete',
		kind: 'forgetInvite',
		tier: 'admin',
		summary: 'Withdraw an invite',
	},
	{ path: '/v1/nodes', method: 'get', kind: 'listNodes', tier: 'admin', summary: 'List supervised hydra-nodes' },
	{
		path: '/v1/nodes',
		method: 'post',
		kind: 'provisionNode',
		tier: 'admin',
		summary: 'Provision a new hydra-node',
		description:
			'Allocates ports, generates keys and starts a supervised hydra-node. Idempotent via the Idempotency-Key header. Exact body: see provision.ts.',
	},
	{ path: '/v1/nodes/{nodeId}', method: 'get', kind: 'getNode', tier: 'admin', summary: 'One node, public fields' },
	{
		path: '/v1/nodes/{nodeId}',
		method: 'patch',
		kind: 'setPeers',
		tier: 'admin',
		summary: 'Set the node’s Hydra peers',
	},
	{
		path: '/v1/nodes/{nodeId}',
		method: 'delete',
		kind: 'removeNode',
		tier: 'admin',
		summary: 'Remove a node (drains first; ?force=true skips the drain)',
	},
	{
		path: '/v1/nodes/{nodeId}/escrow-ack',
		method: 'post',
		kind: 'escrowAck',
		tier: 'admin',
		summary: 'Acknowledge the provisioning escrow',
	},
	{ path: '/v1/nodes/{nodeId}/start', method: 'post', kind: 'startNode', tier: 'admin', summary: 'Start the node' },
	{ path: '/v1/nodes/{nodeId}/stop', method: 'post', kind: 'stopNode', tier: 'admin', summary: 'Stop the node' },
	{
		path: '/v1/nodes/{nodeId}/restart',
		method: 'post',
		kind: 'restartNode',
		tier: 'admin',
		summary: 'Restart the node',
	},
	{
		path: '/v1/nodes/{nodeId}/health',
		method: 'get',
		kind: 'nodeHealth',
		tier: 'user',
		summary: 'Is this node usable right now?',
		description: 'State, sync/drift from the supervisor’s last probe, and when it last looked.',
	},
] as const;

/**
 * The node-API proxy is not in the route table (it is the fall-through), so it
 * is documented separately. The allow-list is authoritative in proxy-path.ts.
 */
const PROXY_DESCRIPTION =
	'Forwards to the supervised hydra-node’s own API, gated by an allow-list — ' +
	'GET: /head, /snapshot, /snapshot/utxo, /snapshot/last-seen, /commits, /protocol-parameters; ' +
	'POST: /snapshot, /commit, /decommit, /transaction, /cardano-transaction; ' +
	'DELETE: /commits/{txId}. WebSocket upgrades on the same prefix carry the head’s event stream. ' +
	'Requires the user token.';

type ParameterObject = {
	name: string;
	in: 'path';
	required: true;
	schema: { type: 'string' };
};

type OperationObject = {
	summary: string;
	description?: string;
	tags: string[];
	security: Array<Record<string, string[]>>;
	parameters?: ParameterObject[];
	responses: Record<string, { description: string }>;
};

export type OpenApiDocument = {
	openapi: string;
	info: { title: string; version: string; description: string };
	components: { securitySchemes: { bearerAuth: { type: 'http'; scheme: 'bearer' } } };
	paths: Record<string, Record<string, OperationObject>>;
};

function pathParameters(path: string): ParameterObject[] | undefined {
	const names = [...path.matchAll(/\{([a-zA-Z]+)\}/g)].map((match) => match[1]);
	if (names.length === 0) return undefined;
	return names.map((name) => ({
		name,
		in: 'path',
		required: true,
		schema: { type: 'string' },
	}));
}

export function buildOpenApiDocument(): OpenApiDocument {
	const paths: Record<string, Record<string, OperationObject>> = {};
	for (const operation of DOCUMENTED_OPERATIONS) {
		const entry = (paths[operation.path] ??= {});
		entry[operation.method] = {
			summary: operation.summary,
			...(operation.description === undefined ? {} : { description: operation.description }),
			tags: [operation.path.startsWith('/v1/invites') ? 'exchange' : 'nodes'],
			security: [{ bearerAuth: [] }],
			...(pathParameters(operation.path) === undefined ? {} : { parameters: pathParameters(operation.path) }),
			responses: {
				default: { description: `Requires the ${operation.tier} token. JSON responses; errors are {"error": string}.` },
			},
		};
	}
	paths['/v1/nodes/{nodeId}/api/{subPath}'] = {
		get: {
			summary: 'Proxy to the node’s own API (allow-listed)',
			description: PROXY_DESCRIPTION,
			tags: ['proxy'],
			security: [{ bearerAuth: [] }],
			parameters: pathParameters('/v1/nodes/{nodeId}/api/{subPath}'),
			responses: { default: { description: 'Whatever the hydra-node answers, forwarded.' } },
		},
	};

	return {
		openapi: '3.0.3',
		info: {
			title: 'Masumi Hydra Host — control plane',
			version: 'v1',
			description:
				'Token-gated API that provisions and supervises hydra-node processes. ' +
				'Two bearer tiers: the admin token operates nodes and invites; the user token reads health and uses the node-API proxy. ' +
				'The Exchange Plane (invite redemption between Hosts) is a separate listener and is not described here.',
		},
		components: {
			securitySchemes: {
				bearerAuth: { type: 'http', scheme: 'bearer' },
			},
		},
		paths,
	};
}
