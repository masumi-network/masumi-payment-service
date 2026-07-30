/**
 * Deriving the on-chain identity of a provisioned node.
 *
 * A Hydra Host hands back the node's Cardano *verification key*; the payment
 * service stores the 28-byte blake2b-224 key hash as `cardanoVkey`, which is
 * what Hydra mints the participant token for and what head verification checks
 * the token against. The Host cannot compute it (node crypto has no
 * blake2b-224), so the derivation lives here, where the mesh line is already a
 * dependency.
 */

import { Ed25519PublicKey, Ed25519PublicKeyHex } from '@meshsdk/core-cst';
import { HydraProtocolError } from '@/lib/hydra/hydra/errors';

const CBOR_BYTES32_PREFIX = '5820';

/** Strip the CBOR byte-string header from a 32-byte Cardano key envelope payload. */
export function rawKeyHexFromEnvelope(cborHex: string): string {
	const normalized = cborHex.trim().toLowerCase();
	if (!normalized.startsWith(CBOR_BYTES32_PREFIX) || normalized.length !== CBOR_BYTES32_PREFIX.length + 64) {
		throw new HydraProtocolError(`not a 32-byte Cardano key payload: ${cborHex}`);
	}
	return normalized.slice(CBOR_BYTES32_PREFIX.length);
}

/**
 * The 28-byte key hash for a node's Cardano verification key.
 *
 * Requires libsodium to be initialised, which the service does at boot and the
 * jest setup does for tests.
 */
export function deriveNodeCardanoVkey(verificationKeyCborHex: string): string {
	const rawHex = rawKeyHexFromEnvelope(verificationKeyCborHex);
	let hash: string;
	try {
		const hashed = Ed25519PublicKey.fromHex(Ed25519PublicKeyHex(rawHex)).hash();
		hash = typeof hashed === 'string' ? hashed : String(hashed.hex?.() ?? hashed);
	} catch (error) {
		throw new HydraProtocolError(`could not derive the node key hash: ${(error as Error).message}`);
	}
	if (!/^[0-9a-f]{56}$/.test(hash)) {
		throw new HydraProtocolError(`derived node key hash is not 28 bytes: ${hash}`);
	}
	return hash;
}
