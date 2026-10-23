/**
 * Bearer-token authentication for the control plane.
 *
 * This is the only thing standing in front of an API that has no
 * authentication of its own and, if reached, can close a head — so comparisons
 * are constant-time and failures never say which part was wrong.
 *
 * Tokens are compared as SHA-256 digests rather than raw strings so that
 * `timingSafeEqual` always sees equal-length inputs; comparing raw strings
 * would either throw on a length mismatch or leak the token length.
 */

import { createHash, timingSafeEqual } from 'node:crypto';
import { deriveNodeToken } from './node-token.js';

export type Tier = 'admin' | 'user';

export type AuthResult =
	| { ok: true; tier: Tier; hostWideUserToken?: true }
	| { ok: false; status: 401 | 403; message: string };

function digest(value: string): Buffer {
	return createHash('sha256').update(value, 'utf8').digest();
}

export function constantTimeEquals(a: string, b: string): boolean {
	return timingSafeEqual(digest(a), digest(b));
}

/** Pull the credential out of an `Authorization: Bearer <token>` header. */
export function parseBearer(header: string | undefined | null): string | null {
	if (typeof header !== 'string') {
		return null;
	}
	const match = /^Bearer[ \t]+(\S+)$/i.exec(header.trim());
	return match === null ? null : match[1];
}

export type TokenSet = { adminToken: string; userToken: string };

/**
 * Resolve the caller's tier.
 *
 * Admin is a superset of user: an operator holding the admin token can also
 * drive a node, so `required: 'user'` accepts either. Both candidate
 * comparisons always run, so the work done does not depend on which token was
 * presented.
 */
export function authenticate(header: string | undefined | null, tokens: TokenSet, required: Tier): AuthResult {
	const presented = parseBearer(header);
	if (presented === null) {
		return { ok: false, status: 401, message: 'missing or malformed Authorization header' };
	}

	const isAdmin = constantTimeEquals(presented, tokens.adminToken);
	const isUser = constantTimeEquals(presented, tokens.userToken);

	if (!isAdmin && !isUser) {
		return { ok: false, status: 401, message: 'invalid token' };
	}
	if (required === 'admin' && !isAdmin) {
		return { ok: false, status: 403, message: 'this operation requires the admin token' };
	}
	return { ok: true, tier: isAdmin ? 'admin' : 'user' };
}

/**
 * Resolve the caller's tier on a route that belongs to one node.
 *
 * What opens the node is the token derived for it, from either Host token (see
 * `deriveNodeToken`), so a leaked credential reaches that node and no other. The
 * admin token still opens everything. The Host-wide user token reaches every
 * node, so it is accepted only while `acceptHostWideUserToken` is on, and the
 * result says when it was the one presented. Every comparison runs whatever was
 * presented.
 */
export function authenticateNode(
	header: string | undefined | null,
	tokens: TokenSet,
	nodeId: string,
	options: { acceptHostWideUserToken: boolean },
): AuthResult {
	const presented = parseBearer(header);
	if (presented === null) {
		return { ok: false, status: 401, message: 'missing or malformed Authorization header' };
	}

	const isAdmin = constantTimeEquals(presented, tokens.adminToken);
	const isUserNodeToken = constantTimeEquals(presented, deriveNodeToken(tokens.userToken, nodeId));
	const isAdminNodeToken = constantTimeEquals(presented, deriveNodeToken(tokens.adminToken, nodeId));
	const isHostWideUser = constantTimeEquals(presented, tokens.userToken);

	if (isAdmin) {
		return { ok: true, tier: 'admin' };
	}
	if (isUserNodeToken || isAdminNodeToken) {
		return { ok: true, tier: 'user' };
	}
	if (isHostWideUser && options.acceptHostWideUserToken) {
		return { ok: true, tier: 'user', hostWideUserToken: true };
	}
	return { ok: false, status: 401, message: 'invalid token' };
}
