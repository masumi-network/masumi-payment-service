/**
 * Key generation for a provisioned node.
 *
 * Two independent Ed25519 key pairs per node:
 *
 *  - the **Hydra** key, which signs L2 protocol messages and whose verification
 *    key is fixed on chain in the head's participant set;
 *  - the **node Cardano** key, which authorises Hydra protocol transactions and
 *    pays their fees, collateral and change.
 *
 * Both are written as Cardano text envelopes, the format `hydra-node` expects
 * from `--hydra-signing-key` / `--cardano-signing-key`.
 *
 * Note what this module deliberately does NOT produce: the 28-byte blake2b-224
 * key hash that the payment service stores in its own `cardanoVkey` column.
 * Node's crypto has no blake2b-224 (and it is not a truncation of
 * blake2b-512), and pulling in a hashing dependency just for that would drag
 * the container toward the payment service's graph. The Host emits
 * verification keys; the service derives hashes with the mesh helper it
 * already uses.
 */

import { createPrivateKey, createPublicKey, randomBytes } from 'node:crypto';

/** CBOR byte-string header for a 32-byte payload, as used by Cardano envelopes. */
const CBOR_BYTES32_PREFIX = '5820';
/** DER prefix for a PKCS#8-wrapped Ed25519 private key seed. */
const ED25519_PKCS8_SEED_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
const ED25519_SEED_BYTES = 32;

export type TextEnvelope = {
	type: string;
	description: string;
	cborHex: string;
};

export type KeyPair = {
	/** Envelope written to `<keys>/*.sk`. */
	signingKey: TextEnvelope;
	/** Envelope written to `<keys>/*.vk`, and shared with the counterparty. */
	verificationKey: TextEnvelope;
	/** Raw 32-byte public key, hex. */
	verificationKeyHex: string;
};

export class KeyGenerationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'KeyGenerationError';
	}
}

function assertSeed(seed: Buffer): void {
	if (seed.length !== ED25519_SEED_BYTES) {
		throw new KeyGenerationError(`an Ed25519 seed must be ${ED25519_SEED_BYTES} bytes, received ${seed.length}`);
	}
}

/** Derive the raw 32-byte Ed25519 public key from a 32-byte seed. */
export function publicKeyFromSeed(seed: Buffer): Buffer {
	assertSeed(seed);
	const privateKey = createPrivateKey({
		key: Buffer.concat([ED25519_PKCS8_SEED_PREFIX, seed]),
		format: 'der',
		type: 'pkcs8',
	});
	const spki = createPublicKey(privateKey).export({ format: 'der', type: 'spki' });
	// SPKI for Ed25519 is a 12-byte header followed by the raw key.
	return Buffer.from(spki.subarray(spki.length - ED25519_SEED_BYTES));
}

function envelope(type: string, description: string, raw: Buffer): TextEnvelope {
	return { type, description, cborHex: `${CBOR_BYTES32_PREFIX}${raw.toString('hex')}` };
}

function keyPairFromSeed(
	seed: Buffer,
	signingType: string,
	verificationType: string,
	signingDescription: string,
	verificationDescription: string,
): KeyPair {
	const publicKey = publicKeyFromSeed(seed);
	return {
		signingKey: envelope(signingType, signingDescription, seed),
		verificationKey: envelope(verificationType, verificationDescription, publicKey),
		verificationKeyHex: publicKey.toString('hex'),
	};
}

/** Hydra L2 key pair, as produced by `hydra-node gen-hydra-key`. */
export function generateHydraKeyPair(seed: Buffer = randomBytes(ED25519_SEED_BYTES)): KeyPair {
	assertSeed(seed);
	return keyPairFromSeed(seed, 'HydraSigningKey_ed25519', 'HydraVerificationKey_ed25519', '', '');
}

/** Node Cardano payment key pair, as produced by `cardano-cli address key-gen`. */
export function generateCardanoKeyPair(seed: Buffer = randomBytes(ED25519_SEED_BYTES)): KeyPair {
	assertSeed(seed);
	return keyPairFromSeed(
		seed,
		'PaymentSigningKeyShelley_ed25519',
		'PaymentVerificationKeyShelley_ed25519',
		'Payment Signing Key',
		'Payment Verification Key',
	);
}

export function serializeEnvelope(value: TextEnvelope): string {
	return `${JSON.stringify(value, null, 2)}\n`;
}

/**
 * Whether this is the `cborHex` a Cardano or Hydra `.vk` envelope carries: the
 * CBOR header for a 32-byte string followed by exactly that many bytes.
 *
 * Worth checking wherever a key arrives from outside. These strings are written
 * verbatim into the `.vk` files hydra-node reads at startup, so anything else
 * is a node that dies on a parse error the operator has to go and read.
 */
export function isVerificationKeyCborHex(value: string): boolean {
	return new RegExp(`^${CBOR_BYTES32_PREFIX}[0-9a-fA-F]{64}$`).test(value);
}

/** Extract the raw 32-byte payload from an envelope's `cborHex`. */
export function envelopeRawHex(value: TextEnvelope): string {
	const { cborHex } = value;
	if (!cborHex.startsWith(CBOR_BYTES32_PREFIX) || cborHex.length !== CBOR_BYTES32_PREFIX.length + 64) {
		throw new KeyGenerationError(`cborHex is not a 32-byte Cardano key payload: ${cborHex}`);
	}
	return cborHex.slice(CBOR_BYTES32_PREFIX.length);
}
