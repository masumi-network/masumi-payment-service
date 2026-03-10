import cbor from 'cbor';
import { Data } from '@meshsdk/core';
import { CONSTANTS } from '@/utils/config';

export const DEFAULT_OVERHEAD_SIZE = 160;

export const BUFFER_SIZE_COOLDOWN_TIME = 15;

export const BUFFER_SIZE_TX_OUTPUT_HASH = 50;

export const BUFFER_SIZE_PER_UNIT = 50;

export const SAFETY_MARGIN_BYTES = 20;

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

export function calculateMinUtxoWithResultHash(params: MinUtxoCalculationParams): MinUtxoResult {
	const { datum, nativeTokenCount = 0, coinsPerUtxoSize, includeBuffers = true } = params;

	if (Buffer.isBuffer(datum)) {
		const datumSizeBytes = datum.byteLength + CONSTANTS.RESULT_HASH_SIZE_BYTES;
		let totalSizeBytes = datumSizeBytes + DEFAULT_OVERHEAD_SIZE;

		if (includeBuffers) {
			totalSizeBytes += BUFFER_SIZE_TX_OUTPUT_HASH;
			totalSizeBytes += BUFFER_SIZE_COOLDOWN_TIME;
			totalSizeBytes += BUFFER_SIZE_PER_UNIT * nativeTokenCount;
			totalSizeBytes += SAFETY_MARGIN_BYTES;
		}

		return {
			minUtxoLovelace: BigInt(Math.ceil(coinsPerUtxoSize * totalSizeBytes)),
			datumSizeBytes,
			totalSizeBytes,
			buffersIncluded: includeBuffers,
		};
	}

	const datumWithResultHash = addResultHashToDatum(datum, DUMMY_RESULT_HASH);
	return calculateMinUtxo({
		datum: datumWithResultHash,
		nativeTokenCount,
		coinsPerUtxoSize,
		includeBuffers,
	});
}

export function validateMinUtxo(
	currentLovelace: bigint,
	requiredMinUtxo: bigint,
): { isValid: boolean; shortfall: bigint } {
	const isValid = currentLovelace >= requiredMinUtxo;
	const shortfall = isValid ? 0n : requiredMinUtxo - currentLovelace;
	return { isValid, shortfall };
}

export function calculateTopUpAmount(currentLovelace: bigint, requiredMinUtxo: bigint): bigint {
	if (currentLovelace >= requiredMinUtxo) {
		return 0n;
	}
	return requiredMinUtxo - currentLovelace;
}

function addResultHashToDatum(datum: Data, resultHash: string): Data {
	const serialized = JSON.stringify(datum, (_key, value: unknown): unknown =>
		typeof value === 'bigint' ? `__bigint__${value.toString()}` : value,
	);

	const clonedDatum = JSON.parse(serialized, (_key, value: unknown): unknown => {
		if (typeof value === 'string' && value.startsWith('__bigint__')) {
			return BigInt(value.slice(10));
		}
		return value;
	}) as Data;

	if (
		clonedDatum &&
		typeof clonedDatum === 'object' &&
		'fields' in clonedDatum &&
		Array.isArray(clonedDatum.fields) &&
		clonedDatum.fields.length > 8
	) {
		clonedDatum.fields[8] = resultHash;
	}

	return clonedDatum;
}

export function getLovelaceFromAmounts(amounts: Array<{ unit: string; quantity: string }>): bigint {
	const lovelaceEntry = amounts.find((a) => a.unit === '' || a.unit.toLowerCase() === 'lovelace');
	return lovelaceEntry ? BigInt(lovelaceEntry.quantity) : 0n;
}

export function getNativeTokenCount(amounts: Array<{ unit: string; quantity: string }>): number {
	return amounts.filter((a) => a.unit !== '' && a.unit.toLowerCase() !== 'lovelace').length;
}
