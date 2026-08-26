import { describe, expect, it } from '@jest/globals';
import { assertUsableHydraAuthToken, hydraAuthHeaders } from './auth';
import { HydraProtocolError } from './errors';

describe('hydraAuthHeaders', () => {
	it('builds a bearer header', () => {
		expect(hydraAuthHeaders('secret-token')).toEqual({ Authorization: 'Bearer secret-token' });
	});

	// A node on loopback has nothing in front of it to authenticate to, so no
	// header is the correct outcome rather than an error.
	it('returns nothing when no token is configured', () => {
		expect(hydraAuthHeaders(undefined)).toEqual({});
	});

	// The token reaches us through the database and an API, so it is validated
	// rather than trusted: CR/LF would terminate the header and let the rest of
	// the value inject headers of its own.
	it('refuses a token containing control characters', () => {
		// Written as escapes deliberately: a literal control character in source is
		// invisible in review and in a diff.
		for (const bad of ['tok\r\nX-Injected: 1', 'tok\nX: 1', 'tok\0']) {
			expect(() => hydraAuthHeaders(bad)).toThrow(HydraProtocolError);
		}
	});

	// Surrounding whitespace is not a header-injection risk, so it is preserved
	// rather than silently trimmed: rewriting a credential would turn a config
	// typo into a confusing authentication failure instead of an obvious one.
	it('does not reject a token for surrounding whitespace', () => {
		expect(hydraAuthHeaders('tok ')).toEqual({ Authorization: 'Bearer tok ' });
	});

	it('refuses a blank token rather than sending an empty credential', () => {
		expect(() => hydraAuthHeaders('')).toThrow(/must not be blank/);
		expect(() => hydraAuthHeaders('   ')).toThrow(/must not be blank/);
	});

	it('accepts ordinary opaque tokens', () => {
		expect(() => assertUsableHydraAuthToken('a'.repeat(64))).not.toThrow();
		expect(() => assertUsableHydraAuthToken('masumi-hydra.token_value-123')).not.toThrow();
	});
});
