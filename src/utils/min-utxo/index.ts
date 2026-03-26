import cbor from 'cbor';
import { Data } from '@meshsdk/core';

const DEFAULT_OVERHEAD_SIZE = 160;

const BUFFER_SIZE_COOLDOWN_TIME = 15;

const BUFFER_SIZE_TX_OUTPUT_HASH = 50;

const BUFFER_SIZE_PER_UNIT = 50;

const SAFETY_MARGIN_BYTES = 20;

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

	const cborEncodedDatum = Buffer.isBuffer(datum) ? datum : cbor.encode(datum);
	const datumSizeBytes = cborEncodedDatum.byteLength;

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
