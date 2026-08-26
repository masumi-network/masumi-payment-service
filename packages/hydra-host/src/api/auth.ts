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

export type Tier = 'admin' | 'user';

export type AuthResult = { ok: true; tier: Tier } | { ok: false; status: 401 | 403; message: string };

function digest(value: string): Buffer {
	return createHash('sha256').update(value, 'utf8').digest();
}

function constantTimeEquals(a: string, b: string): boolean {
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
