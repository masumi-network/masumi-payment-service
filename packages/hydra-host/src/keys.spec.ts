import { describe, expect, it } from '@jest/globals';
import { createPrivateKey, sign, verify } from 'node:crypto';
import {
	KeyGenerationError,
	envelopeRawHex,
	generateCardanoKeyPair,
	generateHydraKeyPair,
	publicKeyFromSeed,
	serializeEnvelope,
} from './keys.js';

const SEED = Buffer.alloc(32, 7);

describe('publicKeyFromSeed', () => {
	it('is deterministic for a given seed', () => {
		expect(publicKeyFromSeed(SEED).toString('hex')).toBe(publicKeyFromSeed(SEED).toString('hex'));
	});

	it('produces a 32-byte key', () => {
		expect(publicKeyFromSeed(SEED)).toHaveLength(32);
	});

	// The derived key must actually be the Ed25519 public key for the seed, not
	// merely 32 bytes of something. Sign with the seed, verify with the result.
	it('derives the real Ed25519 public key for the seed', () => {
		const privateKey = createPrivateKey({
			key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), SEED]),
			format: 'der',
			type: 'pkcs8',
		});
		const message = Buffer.from('hydra');
		const signature = sign(null, message, privateKey);

		const spki = Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), publicKeyFromSeed(SEED)]);
		expect(verify(null, message, { key: spki, format: 'der', type: 'spki' }, signature)).toBe(true);
	});

	it('rejects a seed of the wrong size', () => {
		expect(() => publicKeyFromSeed(Buffer.alloc(31))).toThrow(KeyGenerationError);
		expect(() => publicKeyFromSeed(Buffer.alloc(64))).toThrow(/32 bytes/);
	});
});

describe('generateHydraKeyPair', () => {
	it('emits the envelope types hydra-node expects', () => {
		const pair = generateHydraKeyPair(SEED);
		expect(pair.signingKey.type).toBe('HydraSigningKey_ed25519');
		expect(pair.verificationKey.type).toBe('HydraVerificationKey_ed25519');
	});

	it('wraps both keys as 32-byte CBOR payloads', () => {
		const pair = generateHydraKeyPair(SEED);
		expect(pair.signingKey.cborHex).toMatch(/^5820[0-9a-f]{64}$/);
		expect(pair.verificationKey.cborHex).toMatch(/^5820[0-9a-f]{64}$/);
	});

	it('carries the seed as the signing key and the derived public key as the vk', () => {
		const pair = generateHydraKeyPair(SEED);
		expect(envelopeRawHex(pair.signingKey)).toBe(SEED.toString('hex'));
		expect(envelopeRawHex(pair.verificationKey)).toBe(publicKeyFromSeed(SEED).toString('hex'));
		expect(pair.verificationKeyHex).toBe(publicKeyFromSeed(SEED).toString('hex'));
	});

	it('generates a different key every time when unseeded', () => {
		expect(generateHydraKeyPair().signingKey.cborHex).not.toBe(generateHydraKeyPair().signingKey.cborHex);
	});
});

describe('generateCardanoKeyPair', () => {
	it('emits the envelope types cardano-cli produces', () => {
		const pair = generateCardanoKeyPair(SEED);
		expect(pair.signingKey.type).toBe('PaymentSigningKeyShelley_ed25519');
		expect(pair.verificationKey.type).toBe('PaymentVerificationKeyShelley_ed25519');
		expect(pair.signingKey.description).toBe('Payment Signing Key');
	});

	// Same seed, different key roles — the two pairs are independent in practice
	// because they are generated from independent random seeds.
	it('derives the same public key as the hydra pair for an identical seed', () => {
		expect(generateCardanoKeyPair(SEED).verificationKeyHex).toBe(generateHydraKeyPair(SEED).verificationKeyHex);
	});
});

describe('serializeEnvelope / envelopeRawHex', () => {
	it('round-trips through JSON with a trailing newline', () => {
		const pair = generateHydraKeyPair(SEED);
		const text = serializeEnvelope(pair.signingKey);
		expect(text.endsWith('\n')).toBe(true);
		expect(JSON.parse(text)).toEqual(pair.signingKey);
	});

	it('rejects a payload that is not a 32-byte cbor byte string', () => {
		expect(() => envelopeRawHex({ type: 't', description: '', cborHex: '58201234' })).toThrow(KeyGenerationError);
		expect(() => envelopeRawHex({ type: 't', description: '', cborHex: 'ff'.repeat(33) })).toThrow(/32-byte/);
	});
});
