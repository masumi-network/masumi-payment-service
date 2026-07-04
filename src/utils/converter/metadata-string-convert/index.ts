import { getOwnEntries, isPlainObject } from '@masumi/payment-core/object-properties';

//internal helper to transform metadata strings as they can be either a string of length<63 or an array of strings <63
//e.g ["this is a very long ","string ","on the registry"] -> "this is a very long string on the registry"
export function metadataToString(value: string | string[] | undefined) {
	if (value == undefined) return undefined;
	if (typeof value === 'string') return value;
	return value.join('');
}
// Cardano's ledger limits a metadata text string to 64 UTF-8 BYTES, not 64
// characters. Splitting on character count lets a multi-byte string (e.g. CJK
// or emoji) produce a chunk that exceeds the ledger limit and makes the whole
// tx unbuildable/rejected. Chunk on byte boundaries without cutting a
// multi-byte character. We keep the historical 60-unit boundary (was 60 chars),
// now interpreted as 60 BYTES — identical to the old behaviour for ASCII and
// safely under the 64-byte ledger max for multi-byte input.
const MAX_METADATA_STRING_BYTES = 60;

export function stringToMetadata(
	s: string | undefined | null,
	forceArray: boolean = true,
): string | string[] | undefined {
	if (s == undefined) {
		return undefined;
	}
	const encoder = new TextEncoder();
	if (encoder.encode(s).length <= MAX_METADATA_STRING_BYTES && forceArray == false) {
		return s;
	}
	const arr: string[] = [];
	let current = '';
	let currentBytes = 0;
	for (const char of s) {
		const charBytes = encoder.encode(char).length;
		if (currentBytes + charBytes > MAX_METADATA_STRING_BYTES && current.length > 0) {
			arr.push(current);
			current = '';
			currentBytes = 0;
		}
		current += char;
		currentBytes += charBytes;
	}
	if (current.length > 0) {
		arr.push(current);
	}
	return arr;
}

export function cleanMetadata(obj: unknown): unknown {
	if (obj === undefined || obj === null) {
		return obj;
	}
	if (Array.isArray(obj)) {
		return obj.filter((item) => item !== undefined).map(cleanMetadata);
	}
	if (isPlainObject(obj)) {
		return Object.fromEntries(
			getOwnEntries(obj).flatMap(([key, value]) => (value !== undefined ? [[key, cleanMetadata(value)] as const] : [])),
		);
	}
	return obj;
}
