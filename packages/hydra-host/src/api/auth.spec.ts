import { describe, expect, it } from '@jest/globals';
import { authenticate, parseBearer } from './auth.js';

const TOKENS = { adminToken: 'a'.repeat(40), userToken: 'u'.repeat(40) };

describe('parseBearer', () => {
	it('extracts the credential, case-insensitively', () => {
		expect(parseBearer('Bearer abc')).toBe('abc');
		expect(parseBearer('bearer abc')).toBe('abc');
		expect(parseBearer('  Bearer   abc  ')).toBe('abc');
	});

	it('returns null for anything that is not a bearer credential', () => {
		expect(parseBearer(undefined)).toBeNull();
		expect(parseBearer(null)).toBeNull();
		expect(parseBearer('')).toBeNull();
		expect(parseBearer('Basic abc')).toBeNull();
		expect(parseBearer('Bearer')).toBeNull();
		expect(parseBearer('Bearer a b')).toBeNull();
	});
});

describe('authenticate', () => {
	it('accepts the admin token for an admin route', () => {
		expect(authenticate(`Bearer ${TOKENS.adminToken}`, TOKENS, 'admin')).toEqual({ ok: true, tier: 'admin' });
	});

	it('accepts the user token for a user route', () => {
		expect(authenticate(`Bearer ${TOKENS.userToken}`, TOKENS, 'user')).toEqual({ ok: true, tier: 'user' });
	});

	// Admin is a superset: an operator holding the admin token can also drive a
	// node, so requiring 'user' must not reject them.
	it('accepts the admin token where only user is required', () => {
		expect(authenticate(`Bearer ${TOKENS.adminToken}`, TOKENS, 'user')).toEqual({ ok: true, tier: 'admin' });
	});

	it('rejects the user token on an admin route with 403, not 401', () => {
		const result = authenticate(`Bearer ${TOKENS.userToken}`, TOKENS, 'admin');
		expect(result).toEqual({ ok: false, status: 403, message: expect.any(String) as unknown as string });
	});

	it('rejects an unknown token with 401', () => {
		expect(authenticate('Bearer nope', TOKENS, 'user')).toMatchObject({ ok: false, status: 401 });
	});

	it('rejects a missing or malformed header with 401', () => {
		expect(authenticate(undefined, TOKENS, 'user')).toMatchObject({ ok: false, status: 401 });
		expect(authenticate('Basic abc', TOKENS, 'user')).toMatchObject({ ok: false, status: 401 });
	});

	// Comparison is over fixed-width digests, so a token of any length is safe
	// to pass to timingSafeEqual and no length is leaked by throwing.
	it('handles tokens of any length without throwing', () => {
		expect(() => authenticate('Bearer x', TOKENS, 'user')).not.toThrow();
		expect(() => authenticate(`Bearer ${'x'.repeat(5000)}`, TOKENS, 'user')).not.toThrow();
	});

	it('does not accept a prefix of a valid token', () => {
		expect(authenticate(`Bearer ${TOKENS.adminToken.slice(0, 39)}`, TOKENS, 'admin')).toMatchObject({ ok: false });
	});
});
