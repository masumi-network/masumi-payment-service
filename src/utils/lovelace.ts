import createHttpError from 'http-errors';

/**
 * Lossless lovelace -> ADA decimal string. Avoids BigInt -> Number precision
 * loss for values above 2^53 lovelace (~9 billion ADA). Returns a string like
 * "12.345678" with trailing zeros trimmed.
 */
export function lovelaceToAdaString(lovelace: bigint, decimals = 6): string {
	const negative = lovelace < 0n;
	const abs = negative ? -lovelace : lovelace;
	const divisor = 10n ** BigInt(decimals);
	const whole = abs / divisor;
	const fraction = abs % divisor;
	const fractionStr = fraction.toString().padStart(decimals, '0').replace(/0+$/, '');
	const sign = negative ? '-' : '';
	return fractionStr.length > 0 ? `${sign}${whole}.${fractionStr}` : `${sign}${whole}`;
}

/**
 * Convert lovelace BigInt to ADA as a Number. Throws an HTTP 500 if the value
 * exceeds Number.MAX_SAFE_INTEGER, which would silently lose precision. Use
 * only when the consumer truly requires a JS Number (e.g. an existing public
 * API contract with `z.number()`). Prefer `lovelaceToAdaString` otherwise.
 */
export function lovelaceToAdaNumberSafe(lovelace: bigint): number {
	if (lovelace > BigInt(Number.MAX_SAFE_INTEGER) || lovelace < -BigInt(Number.MAX_SAFE_INTEGER)) {
		throw createHttpError(500, 'lovelace value exceeds Number.MAX_SAFE_INTEGER');
	}
	return Number(lovelace) / 1_000_000;
}
