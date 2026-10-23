import { describe, expect, it } from '@jest/globals';
import { deriveNodeToken } from './node-token.js';

describe('deriveNodeToken', () => {
	// Pinned against an independent HMAC-SHA256, and against the payment service's
	// own copy, which has to produce the same bytes for a node call to authenticate.
	it.each([
		['u'.repeat(40), 'node-1', 'b90d56dadfb3e960e97f4dc4de836a46402b7b44f0d396f269e3464189ac8179'],
		['a'.repeat(40), 'node-1', '1d62bee51cf9679bdd664c25675bcc0eb3689c4c62fd38439a49a2f6cb56b5de'],
	])('is the HMAC-SHA256 of the node id under %s.. for %s', (secret, nodeId, expected) => {
		expect(deriveNodeToken(secret, nodeId)).toBe(expected);
	});

	it('gives the same token every time', () => {
		expect(deriveNodeToken('s'.repeat(40), 'node-1')).toBe(deriveNodeToken('s'.repeat(40), 'node-1'));
	});

	it('gives each node its own token', () => {
		expect(deriveNodeToken('s'.repeat(40), 'node-1')).not.toBe(deriveNodeToken('s'.repeat(40), 'node-2'));
	});

	it('gives each secret its own token', () => {
		expect(deriveNodeToken('s'.repeat(40), 'node-1')).not.toBe(deriveNodeToken('t'.repeat(40), 'node-1'));
	});

	// A derived token must not reveal the secret behind it or open the Host's own
	// routes, so it can never equal the secret.
	it('is a 64-character hex string, never the secret itself', () => {
		const secret = 's'.repeat(40);
		expect(deriveNodeToken(secret, 'node-1')).toMatch(/^[0-9a-f]{64}$/);
		expect(deriveNodeToken(secret, 'node-1')).not.toBe(secret);
	});
});
