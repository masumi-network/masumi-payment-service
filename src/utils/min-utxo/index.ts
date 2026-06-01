import { Data, serializeData } from '@meshsdk/core';

const DEFAULT_OVERHEAD_SIZE = 160;

const BUFFER_SIZE_COOLDOWN_TIME = 15;

const BUFFER_SIZE_TX_OUTPUT_HASH = 50;

const BUFFER_SIZE_PER_UNIT = 50;

// Headroom on top of the measured datum size + structural buffers (~0.43 ADA at
// coinsPerUtxoSize=4310). Keeps the estimate above the ledger's
// `(160 + outputSize) * coinsPerUtxoByte` floor.
const SAFETY_MARGIN_BYTES = 100;

/**
 * Measure the on-chain Plutus datum size in bytes. `serializeData` returns the
 * real Plutus CBOR (hex), so `length / 2` is the byte count the ledger uses for
 * min-UTxO. A `Buffer` input is already-encoded CBOR.
 *
 * NB: must NOT use `cbor.encode(datum)` — for a mesh `Data` object that encodes
 * the JS object's `alternative`/`fields` keys, over-counting ~2.4x.
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
