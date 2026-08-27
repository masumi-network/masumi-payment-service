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

/**
 * Query parameters permitted on a proxied path, and the values each accepts.
 *
 * An allow-list for the same reason the path set is one. Whatever crosses this
 * boundary reaches an API with no authentication of its own, and forwarding the
 * caller's query verbatim made every parameter a future hydra version adds
 * reachable the day it shipped, on a path already vouched for.
 *
 * The set is the two settings a session pins: whether the socket replays
 * history, and that snapshots carry their UTxO map either way. They are allowed
 * on every proxyable path rather than only the socket, because that is what the
 * client already sends and narrowing it further would be a behaviour change
 * dressed up as hardening.
 */
const ALLOWED_QUERY: ReadonlyMap<string, ReadonlySet<string>> = new Map([
	['history', new Set(['yes', 'no'])],
	['snapshot-utxo', new Set(['yes', 'no'])],
]);

/**
 * The query string to forward, rebuilt from the allow-list rather than filtered.
 *
 * Rebuilding is what makes this closed: a filter forwards whatever it fails to
 * recognise as bad, and this forwards only what it recognises as good. Returns
 * null when the caller asked for a parameter or a value the node API is not
 * offered here, which the caller reports as a refusal rather than quietly
 * dropping. A silently ignored `history=yes` would replay nothing and read as
 * an empty head.
 */
export function buildProxyQuery(search: string): string | null {
	const trimmed = search.startsWith('?') ? search.slice(1) : search;
	if (trimmed.length === 0) {
		return '';
	}

	const forwarded: string[] = [];
	for (const [key, value] of new URLSearchParams(trimmed)) {
		const values = ALLOWED_QUERY.get(key);
		if (values === undefined || !values.has(value)) {
			return null;
		}
		forwarded.push(`${encodeURIComponent(key)}=${encodeURIComponent(value)}`);
	}
	return forwarded.length === 0 ? '' : `?${forwarded.join('&')}`;
}
