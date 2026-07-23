import JSONBig from 'json-bigint';

const hydraJson = JSONBig({
	strict: true,
	useNativeBigInt: true,
	protoAction: 'error',
	// Plutus detailed-schema data legitimately uses a `constructor` field. The
	// parser creates null-prototype objects, so preserving it cannot shadow
	// Object.prototype while dropping it would corrupt valid inline datums.
	constructorAction: 'preserve',
});

/** Parse Hydra JSON without rounding integer quantities above 2^53 - 1. */
export function parseHydraJson(value: string): unknown {
	return hydraJson.parse(value) as unknown;
}

/** Serialize native bigint quantities as exact JSON integer literals. */
export function stringifyHydraJson(value: unknown): string {
	const serialized = hydraJson.stringify(
		value,
		(_key, nestedValue: unknown) => {
			if (
				typeof nestedValue === 'number' &&
				(!Number.isFinite(nestedValue) || (Number.isInteger(nestedValue) && !Number.isSafeInteger(nestedValue)))
			) {
				throw new TypeError('Hydra JSON contained an inexact or non-finite number');
			}
			return nestedValue;
		},
		2,
	);
	if (serialized === undefined) {
		throw new TypeError('Hydra JSON value was not serializable');
	}
	return serialized;
}
