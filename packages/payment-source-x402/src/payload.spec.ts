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

// Frozen on purpose. paymentPayloadHash is the replay key: it is unique on X402Settlement and
// it is the advisory claim key the settle guard takes. If the canonical form ever changes, rows
// written by earlier releases stop matching, the replay fast-path misses, and the service
// re-settles an authorization that is single-use on chain. The digest below was also produced by
// the pre-sanitize implementation, so this vector doubles as proof that adding toJsonValue left
// every already-stored hash intact. Do not regenerate it to make a failing test pass.
const GOLDEN_PAYLOAD = {
	x402Version: 2,
	resource: { url: 'https://agent.example/run' },
	accepted: {
		scheme: 'exact',
		network: 'eip155:84532',
		asset: '0x036cbd53842c5426634e7929541ec2318f3dcf7e',
		amount: '10000',
		payTo: '0x6597342b1dd68216df749a3ccde47be1bf2a98a3',
		maxTimeoutSeconds: 300,
		extra: { assetTransferMethod: 'permit2', decimals: 6 },
	},
	payload: {
		signature: '0xdeadbeef',
		permit2Authorization: {
			from: '0x57abdb59e14b8edebbfd3567b807274763abb4a2',
			permitted: { token: '0x036cbd53842c5426634e7929541ec2318f3dcf7e', amount: '10000' },
			spender: '0x0000000000000000000000000000000000000001',
			nonce: '42',
			deadline: '1800000300',
			witness: { to: '0x6597342b1dd68216df749a3ccde47be1bf2a98a3', validAfter: '1799999700' },
		},
	},
};
const GOLDEN_DIGEST = '94d6ad0f86720d84ec50f1a6bf50500196bffaa5cd698dd2152fc5383829d5f8';

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

	it('matches the frozen digest for the golden payload', () => {
		expect(hashX402PaymentPayload(GOLDEN_PAYLOAD)).toBe(GOLDEN_DIGEST);
	});

	it('keeps the frozen digest when the SDK sets extensions and resource as undefined keys', () => {
		// @x402/core assembles the payload as an object literal, so both keys are present and
		// undefined when the forwarded 402 declared neither. Neither may shift the replay key.
		const { resource: _resource, ...withoutResource } = GOLDEN_PAYLOAD;
		expect(hashX402PaymentPayload({ ...GOLDEN_PAYLOAD, extensions: undefined })).toBe(GOLDEN_DIGEST);
		expect(hashX402PaymentPayload({ ...withoutResource, resource: undefined })).toBe(
			hashX402PaymentPayload(withoutResource),
		);
	});

	it('rejects a non-object payload with a payload-specific error', () => {
		// toJsonValue would otherwise surface `SyntaxError: "undefined" is not valid JSON`.
		expect(() => hashX402PaymentPayload(undefined)).toThrow(TypeError);
		expect(() => hashX402PaymentPayload(undefined)).toThrow(/payment payload must be a non-null object/);
		expect(() => hashX402PaymentPayload(null)).toThrow(TypeError);
	});
});

describe('encryptPaymentPayloadForStorage', () => {
	it('does not throw when extensions is undefined', () => {
		expect(() => encryptPaymentPayloadForStorage(basePayload(undefined))).not.toThrow();
	});

	it('does not throw when resource is undefined', () => {
		expect(() => encryptPaymentPayloadForStorage({ ...GOLDEN_PAYLOAD, resource: undefined })).not.toThrow();
	});
});
