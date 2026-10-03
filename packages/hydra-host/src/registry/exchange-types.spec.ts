/**
 * A redemption is persisted before anyone verifies its signature.
 *
 * The Exchange Plane is unauthenticated and reachable from anywhere, and its
 * body cap is 64KB. `walletAddress`, `exchangeUrl` and the two signature fields
 * are the values this module cannot check against a grammar, so without a
 * ceiling an invitee could store a body-sized string per invite on the
 * persistence volume, and it would sit there until the payment service polled,
 * rejected the signature and cleaned up.
 */

import { describe, expect, it } from '@jest/globals';
import { isExchangeMaterial, isExchangeSignature, type ExchangeMaterial } from './exchange-types.js';

const VALID_KEY = `5820${'a'.repeat(64)}`;

function material(overrides: Partial<ExchangeMaterial> = {}): unknown {
	return {
		walletAddress: 'addr_test1qq0000000000000000000000000000000000000000000000',
		hydraVerificationKey: VALID_KEY,
		cardanoVerificationKey: VALID_KEY,
		advertise: 'hydra2.example.com:5001',
		exchangeUrl: 'https://hydra2.example.com:8444/exchange',
		...overrides,
	};
}

describe('isExchangeMaterial', () => {
	it('accepts a well-formed redemption', () => {
		expect(isExchangeMaterial(material())).toBe(true);
	});

	it('refuses a wallet address past its ceiling', () => {
		expect(isExchangeMaterial(material({ walletAddress: 'a'.repeat(257) }))).toBe(false);
		expect(isExchangeMaterial(material({ walletAddress: 'a'.repeat(256) }))).toBe(true);
	});

	it('refuses an exchange URL past its ceiling', () => {
		expect(isExchangeMaterial(material({ exchangeUrl: `https://e.example.com/${'a'.repeat(2048)}` }))).toBe(false);
	});

	// An empty string is not a usable address or URL, and storing one produces a
	// node that dies at startup rather than a refusal the counterparty can read.
	it('refuses empty free-form values', () => {
		expect(isExchangeMaterial(material({ walletAddress: '' }))).toBe(false);
		expect(isExchangeMaterial(material({ exchangeUrl: '' }))).toBe(false);
	});

	it('still refuses the shapes it always refused', () => {
		expect(isExchangeMaterial(material({ hydraVerificationKey: 'not-cbor' }))).toBe(false);
		expect(isExchangeMaterial(material({ advertise: 'hydra2.example.com' }))).toBe(false);
		expect(isExchangeMaterial(null)).toBe(false);
	});
});

describe('isExchangeSignature', () => {
	it('accepts a signature and key', () => {
		expect(isExchangeSignature({ signature: 'abc', key: 'def' })).toBe(true);
	});

	it('refuses either field past its ceiling', () => {
		expect(isExchangeSignature({ signature: 'a'.repeat(4097), key: 'def' })).toBe(false);
		expect(isExchangeSignature({ signature: 'abc', key: 'a'.repeat(4097) })).toBe(false);
	});

	it('refuses either field empty', () => {
		expect(isExchangeSignature({ signature: '', key: 'def' })).toBe(false);
		expect(isExchangeSignature({ signature: 'abc', key: '' })).toBe(false);
	});
});
