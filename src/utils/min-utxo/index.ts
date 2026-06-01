import { Data, serializeData } from '@meshsdk/core';

const DEFAULT_OVERHEAD_SIZE = 160;

const BUFFER_SIZE_COOLDOWN_TIME = 15;

const BUFFER_SIZE_TX_OUTPUT_HASH = 50;

const BUFFER_SIZE_PER_UNIT = 50;

// Headroom on top of the measured datum size + structural buffers. Bumped from
// 20 to 100 when the datum measurement was corrected (see computeDatumSizeBytes):
// the old `cbor.encode(meshDataObject)` over-counted ~2.4x and that inflation
// was inadvertently acting as the real safety cushion. With accurate sizing the
// estimate sits ~0.04 ADA above the ledger floor at margin=20 — too thin for a
// money path. 100 bytes (~0.43 ADA at coinsPerUtxoSize=4310) keeps the estimate
// comfortably above the ledger's `(160 + outputSize) * coinsPerUtxoByte` floor
// while still ~half the pre-fix over-funding.
const SAFETY_MARGIN_BYTES = 100;

/**
 * Measure the on-chain Plutus datum size in bytes.
 *
 * IMPORTANT: this used to be `cbor.encode(datum).byteLength`, which — for a mesh
 * `Data` object like `{ alternative, fields: [...] }` — CBOR-encoded the JS
 * object literally (every nested constructor's `"alternative"`/`"fields"` key
 * strings included), producing ~1553 bytes for a datum whose real Plutus CBOR is
 * ~644 bytes. That ~2.4x inflation pushed every V1/V2 lock's min-UTxO to ~7.75
 * ADA instead of ~3.8 ADA, siloing ~2x the necessary ADA per lock and forcing
 * batch wallets to hold far more than required.
 *
 * `serializeData` returns the actual Plutus datum CBOR (hex), so `length / 2` is
 * the true on-chain datum byte count — the same bytes the ledger measures when
 * computing the output's min-UTxO. A `Buffer` input is already-encoded CBOR, so
 * its `byteLength` is used directly.
 */
function computeDatumSizeBytes(datum: Data | Buffer): number {
	if (Buffer.isBuffer(datum)) {
		return datum.byteLength;
	}
	return serializeData(datum).length / 2;
}

export const DUMMY_RESULT_HASH = 'd4735e3a265e16eee03f59718b9b5d03019c07d8b6c51f90da3a666eec13ab35';

export interface MinUtxoCalculationParams {
	datum: Data | Buffer;
	nativeTokenCount?: number;
	coinsPerUtxoSize: number;
	includeBuffers?: boolean;
}

export interface MinUtxoResult {
	minUtxoLovelace: bigint;
	datumSizeBytes: number;
	totalSizeBytes: number;
	buffersIncluded: boolean;
}

export function calculateMinUtxo(params: MinUtxoCalculationParams): MinUtxoResult {
	const { datum, nativeTokenCount = 0, coinsPerUtxoSize, includeBuffers = true } = params;

	const datumSizeBytes = computeDatumSizeBytes(datum);

	let totalSizeBytes = datumSizeBytes + DEFAULT_OVERHEAD_SIZE;

	if (includeBuffers) {
		totalSizeBytes += BUFFER_SIZE_TX_OUTPUT_HASH;
		totalSizeBytes += BUFFER_SIZE_COOLDOWN_TIME;
		totalSizeBytes += BUFFER_SIZE_PER_UNIT * nativeTokenCount;
		totalSizeBytes += SAFETY_MARGIN_BYTES;
	}

	const minUtxoLovelace = BigInt(Math.ceil(coinsPerUtxoSize * totalSizeBytes));

	return {
		minUtxoLovelace,
		datumSizeBytes,
		totalSizeBytes,
		buffersIncluded: includeBuffers,
	};
}

export function calculateTopUpAmount(currentLovelace: bigint, requiredMinUtxo: bigint): bigint {
	if (currentLovelace >= requiredMinUtxo) {
		return 0n;
	}
	return requiredMinUtxo - currentLovelace;
}

export function getLovelaceFromAmounts(amounts: Array<{ unit: string; quantity: string }>): bigint {
	const lovelaceEntry = amounts.find((a) => a.unit === '' || a.unit.toLowerCase() === 'lovelace');
	return lovelaceEntry ? BigInt(lovelaceEntry.quantity) : 0n;
}

export function getNativeTokenCount(amounts: Array<{ unit: string; quantity: string }>): number {
	return amounts.filter((a) => a.unit !== '' && a.unit.toLowerCase() !== 'lovelace').length;
}
