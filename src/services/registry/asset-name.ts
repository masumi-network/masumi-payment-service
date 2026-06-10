// V2 registry asset-name derivation — pure naming logic with no Mesh SDK
// dependency (only `blake2b` + the `UTxO` *type*, which is erased at compile
// time). Kept separate from `shared.ts` so it can be unit-tested without
// pulling in `@meshsdk/core` and its libsodium WASM init.
//
// V2 registry mint contract requires asset names of the exact structure:
//   [ 1 byte nonce > 0x0f | 28 bytes blake2b_224(tx_id || index_be4) | 3 bytes version 0x000000 ]
// (see smart-contracts/registry-v2/validators/mint.ak). The nonce > 0x0f guard
// keeps registry asset names out of the CIP-67/CIP-68 label-prefix range. The
// version field starts at 0 and increments by 1 on every UpdateAction.
import { blake2b } from 'ethereum-cryptography/blake2b';
import type { UTxO } from '@meshsdk/core';

const V2_REGISTRY_INITIAL_NONCE = '10'; // 0x10 — first byte strictly > 0x0f
const V2_REGISTRY_INITIAL_VERSION = '000000'; // 3 bytes BE, starts at 0
const V2_REGISTRY_ASSET_NAME_HEX_LENGTH = 64; // 32 bytes
const V2_REGISTRY_VERSION_MAX = 0xffffff;

// Lowest/highest legal 1-byte nonce. The contract requires nonce > 0x0f, so the
// usable range is 0x10..0xff — 240 distinct nonces. Each distinct nonce lets one
// consumed `firstUtxo` authorize one more mint in the same tx (the oneshot rule:
// asset name = [nonce | blake2b_224(firstUtxo) | version], and the validator only
// checks the 28-byte root against the spent inputs, not the nonce). So a single
// UTxO can seed a whole batch of agents, one nonce per agent.
export const V2_REGISTRY_NONCE_MIN = 0x10;
export const V2_REGISTRY_NONCE_MAX = 0xff;
export const V2_REGISTRY_MAX_MINTS_PER_UTXO = V2_REGISTRY_NONCE_MAX - V2_REGISTRY_NONCE_MIN + 1; // 240

// Map a 0-based batch index to its nonce hex byte. Index 0 -> '10', 1 -> '11', …
export function registryNonceForIndex(index: number): string {
	const nonceValue = V2_REGISTRY_NONCE_MIN + index;
	if (!Number.isInteger(index) || index < 0 || nonceValue > V2_REGISTRY_NONCE_MAX) {
		throw new Error(
			`V2 registry batch index ${index} exceeds the ${V2_REGISTRY_MAX_MINTS_PER_UTXO}-mint-per-UTxO nonce range`,
		);
	}
	return nonceValue.toString(16).padStart(2, '0');
}

// `nonce` is the 1-byte hex prefix of the asset name. Defaults to the canonical
// 0x10 for single mints; batch callers pass a distinct nonce per item (via
// `registryNonceForIndex`) so every agent in the batch can share ONE firstUtxo.
export function generateRegistryAssetNameV2(firstUtxo: UTxO, nonce: string = V2_REGISTRY_INITIAL_NONCE): string {
	if (!/^[0-9a-f]{2}$/.test(nonce)) {
		throw new Error(`V2 registry nonce must be exactly 2 lowercase hex chars, got '${nonce}'`);
	}
	const nonceValue = parseInt(nonce, 16);
	if (nonceValue < V2_REGISTRY_NONCE_MIN || nonceValue > V2_REGISTRY_NONCE_MAX) {
		throw new Error(`V2 registry nonce must be in 0x10..0xff, got '${nonce}'`);
	}
	const txId = firstUtxo.input.txHash;
	const txIndex = firstUtxo.input.outputIndex;
	const serializedOutput = txId + txIndex.toString(16).padStart(8, '0');
	const serializedOutputUint8Array = new Uint8Array(Buffer.from(serializedOutput.toString(), 'hex'));
	// 28-byte root hash matches the contract's `blake2b_224(...)` of the same input.
	const rootHashBytes = blake2b(serializedOutputUint8Array, 28);
	const rootHashHex = Buffer.from(rootHashBytes).toString('hex');
	return nonce + rootHashHex + V2_REGISTRY_INITIAL_VERSION;
}

// Compute the next-version V2 asset name for an UpdateAction. The on-chain
// validator (smart-contracts/registry-v2/validators/mint.ak) requires the new
// asset name to share the burned asset's 1-byte nonce + 28-byte root_hash and
// to carry a 3-byte version that is the burned version + 1. Version overflow
// past 0xFFFFFF is rejected explicitly because the chain check uses big-endian
// from_int + 1 and a wrap-around there would produce the contract's own
// `update_asset_rejects_max_version_overflow` failure mode.
export function bumpRegistryAssetNameVersionV2(assetNameHex: string): string {
	if (assetNameHex.length !== V2_REGISTRY_ASSET_NAME_HEX_LENGTH) {
		throw new Error(
			`V2 registry asset name must be ${V2_REGISTRY_ASSET_NAME_HEX_LENGTH} hex chars, got ${assetNameHex.length}`,
		);
	}
	const noncePart = assetNameHex.slice(0, 2);
	const rootHashPart = assetNameHex.slice(2, 58);
	const versionPart = assetNameHex.slice(58, 64);
	const currentVersion = parseInt(versionPart, 16);
	if (!Number.isFinite(currentVersion)) {
		throw new Error(`V2 registry asset name has non-hex version segment: ${versionPart}`);
	}
	const nextVersion = currentVersion + 1;
	if (nextVersion > V2_REGISTRY_VERSION_MAX) {
		throw new Error('V2 registry asset version would overflow 0xFFFFFF');
	}
	const nextVersionHex = nextVersion.toString(16).padStart(6, '0');
	return noncePart + rootHashPart + nextVersionHex;
}
