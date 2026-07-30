import { describe, expect, it } from '@jest/globals';
import { Network } from '@/generated/prisma/client';
import { nodeCardanoAddress } from './node-address';

// A real 28-byte blake2b-224 key hash, of the shape HydraLocalParticipant.cardanoVkey holds.
const KEY_HASH = '92baa48b5606aabbccddeeff00112233445566778899aabbccddeeff';

describe('nodeCardanoAddress', () => {
	it('derives a testnet enterprise address on preprod', () => {
		const address = nodeCardanoAddress(KEY_HASH, Network.Preprod);
		expect(address.startsWith('addr_test1')).toBe(true);
	});

	it('derives a mainnet address on mainnet', () => {
		const address = nodeCardanoAddress(KEY_HASH, Network.Mainnet);
		expect(address.startsWith('addr1')).toBe(true);
	});

	// Funding the wrong network's address would send real ADA nowhere
	// recoverable, so the two must never collide.
	it('gives different addresses per network for one key', () => {
		expect(nodeCardanoAddress(KEY_HASH, Network.Preprod)).not.toBe(nodeCardanoAddress(KEY_HASH, Network.Mainnet));
	});

	it('is deterministic', () => {
		expect(nodeCardanoAddress(KEY_HASH, Network.Preprod)).toBe(nodeCardanoAddress(KEY_HASH, Network.Preprod));
	});

	it('accepts an upper-case hash', () => {
		expect(nodeCardanoAddress(KEY_HASH.toUpperCase(), Network.Preprod)).toBe(
			nodeCardanoAddress(KEY_HASH, Network.Preprod),
		);
	});

	// The address is a funding destination, so a malformed hash must fail loudly
	// rather than produce a plausible address nobody holds the key to.
	it.each([
		['too short', KEY_HASH.slice(0, 54)],
		['too long', `${KEY_HASH}ab`],
		['not hex', `${KEY_HASH.slice(0, 54)}zz`],
		['empty', ''],
		['a bech32 address', 'addr_test1vzft4fyt2cr2424242424242424242424242424242424242swmv5es'],
	])('refuses a hash that is %s', (_label, value) => {
		expect(() => nodeCardanoAddress(value, Network.Preprod)).toThrow();
	});
});
