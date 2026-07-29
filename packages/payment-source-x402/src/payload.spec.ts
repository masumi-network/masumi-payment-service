import { describe, expect, it, jest } from '@jest/globals';

jest.unstable_mockModule('@masumi/payment-core/db', () => ({
	Prisma: {},
}));

const { hashX402PaymentPayload, encryptPaymentPayloadForStorage } = await import('./payload');

// A buyer signing a payment with no x402 extensions gets this exact shape back from
// @x402/core's client: `extensions` is set to `undefined` rather than omitted.
function basePayload(extensions: unknown) {
	return {
		x402Version: 2,
		resource: { url: 'https://example.com/resource' },
		accepted: {
			scheme: 'exact',
			network: 'eip155:84532',
			asset: '0x036cbd53842c5426634e7929541ec2318f3dcf7e',
			amount: '10000',
			payTo: '0x6597342b1dD68216Df749a3ccDE47Be1BF2A98A3',
			maxTimeoutSeconds: 300,
			extra: { assetTransferMethod: 'permit2', decimals: 6 },
		},
		payload: {
			signature: '0xabc',
			permit2Authorization: { from: '0x57ABDB59e14b8eDeBBfD3567B807274763aBb4a2' },
		},
		extensions,
	};
}

describe('hashX402PaymentPayload', () => {
	it('does not throw when extensions is undefined (the default, no-extensions case)', () => {
		expect(() => hashX402PaymentPayload(basePayload(undefined))).not.toThrow();
	});

	it('returns a stable 64-char sha256 hex digest', () => {
		const hash = hashX402PaymentPayload(basePayload(undefined));
		expect(hash).toMatch(/^[a-f0-9]{64}$/);
		expect(hashX402PaymentPayload(basePayload(undefined))).toBe(hash);
	});

	it('hashes an undefined extensions key the same as an omitted one', () => {
		const withUndefined = basePayload(undefined);
		const { extensions: _omit, ...withoutKey } = withUndefined;
		expect(hashX402PaymentPayload(withUndefined)).toBe(hashX402PaymentPayload(withoutKey));
	});

	it('still distinguishes payloads with real, differing extensions', () => {
		const a = hashX402PaymentPayload(basePayload({ foo: 'bar' }));
		const b = hashX402PaymentPayload(basePayload({ foo: 'baz' }));
		expect(a).not.toBe(b);
	});
});

describe('encryptPaymentPayloadForStorage', () => {
	it('does not throw when extensions is undefined', () => {
		expect(() => encryptPaymentPayloadForStorage(basePayload(undefined))).not.toThrow();
	});
});
