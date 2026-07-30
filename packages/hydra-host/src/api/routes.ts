/**
 * Route table for the control plane.
 *
 * Kept as data, separate from the HTTP server, so the tier each route demands
 * is reviewable in one place and assertable in tests — the alternative,
 * scattering auth checks through handlers, is how an admin-only operation
 * quietly becomes reachable with a user token.
 */

import type { Tier } from './auth.js';

export type Method = 'GET' | 'POST' | 'PATCH' | 'DELETE';

export type RouteKind =
	| 'listNodes'
	| 'getNode'
	| 'provisionNode'
	| 'escrowAck'
	| 'setPeers'
	| 'startNode'
	| 'stopNode'
	| 'restartNode'
	| 'removeNode'
	| 'nodeHealth'
	| 'capabilities'
	| 'peerAllowlist';

export type RouteMatch = {
	kind: RouteKind;
	tier: Tier;
	nodeId?: string;
};

const NODE_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Resolve a request to a route.
 *
 * Returns null for anything unrecognised — notably, this table has no entry
 * that proxies the node's own API, so `GET /config` (which discloses
 * signing-key paths and the persistence directory) is unreachable through the
 * control plane.
 */
export function matchRoute(method: string, pathname: string): RouteMatch | null {
	const segments = pathname.split('/').filter((segment) => segment.length > 0);
	if (segments[0] !== 'v1') {
		return null;
	}

	if (segments.length === 2 && segments[1] === 'capabilities' && method === 'GET') {
		return { kind: 'capabilities', tier: 'admin' };
	}

	// Admin: it enumerates every head's peer port and who may reach it, which is
	// a map of the Host's public surface.
	if (segments.length === 2 && segments[1] === 'peer-allowlist' && method === 'GET') {
		return { kind: 'peerAllowlist', tier: 'admin' };
	}

	if (segments[1] !== 'nodes') {
		return null;
	}

	if (segments.length === 2) {
		if (method === 'GET') {
			return { kind: 'listNodes', tier: 'admin' };
		}
		if (method === 'POST') {
			return { kind: 'provisionNode', tier: 'admin' };
		}
		return null;
	}

	const nodeId = segments[2];
	if (!NODE_ID_PATTERN.test(nodeId)) {
		return null;
	}

	if (segments.length === 3) {
		if (method === 'GET') {
			return { kind: 'getNode', tier: 'admin', nodeId };
		}
		if (method === 'PATCH') {
			return { kind: 'setPeers', tier: 'admin', nodeId };
		}
		if (method === 'DELETE') {
			return { kind: 'removeNode', tier: 'admin', nodeId };
		}
		return null;
	}

	if (segments.length === 4) {
		const action = segments[3];
		if (method === 'POST') {
			switch (action) {
				case 'escrow-ack':
					return { kind: 'escrowAck', tier: 'admin', nodeId };
				case 'start':
					return { kind: 'startNode', tier: 'admin', nodeId };
				case 'stop':
					return { kind: 'stopNode', tier: 'admin', nodeId };
				case 'restart':
					return { kind: 'restartNode', tier: 'admin', nodeId };
				default:
					return null;
			}
		}
		// Health is the one route a user token may read: it is what the payment
		// service polls to decide whether a node is usable.
		if (method === 'GET' && action === 'health') {
			return { kind: 'nodeHealth', tier: 'user', nodeId };
		}
		return null;
	}

	return null;
}
