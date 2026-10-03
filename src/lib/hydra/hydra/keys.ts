import { createPrivateKey, createPublicKey } from 'node:crypto';

import { getOwnValue, isPlainObject } from '@masumi/payment-core/object-properties';
import { HydraProtocolError } from './errors';

const HYDRA_KEY_CBOR_PREFIX = '5820';
const ED25519_PKCS8_SEED_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

type KeyKind = 'signing' | 'verification';

function extractHydraKeyCborHex(input: string, kind: KeyKind): string {
	let value = input.trim();
	if (value.startsWith('{')) {
		let envelope: unknown;
		try {
			envelope = JSON.parse(value);
		} catch (error) {
			throw new HydraProtocolError(`Hydra ${kind} key text envelope is invalid JSON`, { cause: error });
		}
		if (!isPlainObject(envelope)) {
			throw new HydraProtocolError(`Hydra ${kind} key text envelope must be an object`);
		}
		const envelopeType = getOwnValue(envelope, 'type');
		if (typeof envelopeType === 'string') {
			const expectedType = kind === 'signing' ? /SigningKey/i : /VerificationKey/i;
			if (!expectedType.test(envelopeType)) {
				throw new HydraProtocolError(`Hydra ${kind} key text envelope has the wrong key type`);
			}
		}
		const cborHex = getOwnValue(envelope, 'cborHex');
		if (typeof cborHex !== 'string') {
			throw new HydraProtocolError(`Hydra ${kind} key text envelope omitted cborHex`);
		}
		value = cborHex.trim();
	}

	if (/^[0-9a-fA-F]{64}$/.test(value)) value = HYDRA_KEY_CBOR_PREFIX + value;
	if (!/^5820[0-9a-fA-F]{64}$/.test(value)) {
		throw new HydraProtocolError(`Hydra ${kind} key must contain exactly one CBOR-encoded 32-byte key`);
	}
	return value.toLowerCase();
}

export function normalizeHydraSigningKeyCborHex(input: string): string {
	return extractHydraKeyCborHex(input, 'signing');
}

export function normalizeHydraVerificationKeyCborHex(input: string): string {
	return extractHydraKeyCborHex(input, 'verification');
}

export function hydraVerificationKeyRawHex(input: string): string {
	return normalizeHydraVerificationKeyCborHex(input).slice(HYDRA_KEY_CBOR_PREFIX.length);
}

export function deriveHydraVerificationKeyCborHex(signingKey: string): string {
	const normalizedSigningKey = normalizeHydraSigningKeyCborHex(signingKey);
	const seed = Buffer.from(normalizedSigningKey.slice(HYDRA_KEY_CBOR_PREFIX.length), 'hex');
	try {
		const privateKey = createPrivateKey({
			key: Buffer.concat([ED25519_PKCS8_SEED_PREFIX, seed]),
			format: 'der',
			type: 'pkcs8',
		});
		const publicKey = createPublicKey(privateKey).export({ format: 'der', type: 'spki' });
		const rawPublicKey = Buffer.from(publicKey).subarray(-32);
		if (rawPublicKey.length !== 32) throw new Error('derived Ed25519 key had the wrong length');
		return HYDRA_KEY_CBOR_PREFIX + rawPublicKey.toString('hex');
	} catch (error) {
		throw new HydraProtocolError('Hydra signing key could not derive an Ed25519 verification key', { cause: error });
	}
}
