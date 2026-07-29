/**
 * Which hydra-node API paths may be reached through the proxy.
 *
 * This is an **allow-list, not a deny-list**. hydra-node has no authentication
 * of its own, so anything reachable here is reachable by whoever holds the user
 * token; a deny-list would silently expose every endpoint a future hydra
 * version adds. Concretely it keeps `GET /config` — which discloses
 * signing-key paths and the persistence directory — unreachable, without
 * relying on anyone remembering to block it.
 *
 * The path set is deliberately the surface the payment service actually uses.
 */

export type ProxyTarget = { nodeId: string; subPath: string };

const NODE_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/** Exact paths permitted per method. `/commits/{txid}` is handled separately. */
const ALLOWED: Readonly<Record<string, ReadonlySet<string>>> = {
	GET: new Set(['/head', '/snapshot', '/snapshot/utxo', '/snapshot/last-seen', '/commits', '/protocol-parameters']),
	POST: new Set(['/snapshot', '/commit', '/decommit', '/transaction', '/cardano-transaction']),
	DELETE: new Set([]),
};

/** `DELETE /commits/{txid}` recovers a pending deposit. */
const COMMIT_RECOVERY_PATTERN = /^\/commits\/[0-9a-fA-F]{64}$/;

/**
 * Split `/v1/nodes/{id}/api[/rest]` into its node and sub-path.
 * Returns null for anything that is not a node-API request.
 */
export function matchNodeApiProxy(pathname: string): ProxyTarget | null {
	const segments = pathname.split('/').filter((segment) => segment.length > 0);
	if (segments.length < 4 || segments[0] !== 'v1' || segments[1] !== 'nodes' || segments[3] !== 'api') {
		return null;
	}
	const nodeId = segments[2];
	if (!NODE_ID_PATTERN.test(nodeId)) {
		return null;
	}
	const rest = segments.slice(4);
	return { nodeId, subPath: rest.length === 0 ? '/' : `/${rest.join('/')}` };
}

/**
 * Whether a sub-path may be forwarded.
 *
 * `/` is the WebSocket endpoint and is permitted for the upgrade handshake
 * only; a plain HTTP GET of `/` is not useful and is refused.
 */
export function isProxyableHttpPath(method: string, subPath: string): boolean {
	if (method === 'DELETE') {
		return COMMIT_RECOVERY_PATTERN.test(subPath);
	}
	const allowed = ALLOWED[method];
	return allowed !== undefined && allowed.has(subPath);
}

/** The WebSocket endpoint is the node API root. */
export function isProxyableWebSocketPath(subPath: string): boolean {
	return subPath === '/';
}
