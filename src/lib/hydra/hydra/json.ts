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

/**
 * json-bigint hands every number literal longer than 15 characters to
 * `BigInt()`:
 *
 *   // Bignumber has stricter check: everything with length > 15 digits disallowed
 *   if (string.length > 15) return ... BigInt(string)
 *
 * It never checks for a fractional part, and `BigInt('0.05770000000000')`
 * throws. The length is of the whole literal — sign, point and exponent
 * included — so `773500.891234567` (the drift a badly lagging node reports) and
 * a non-zero Plutus price rational both take that branch and make the enclosing
 * document unparseable.
 *
 * That costs more than the field itself. A failed `/protocol-parameters` fetch
 * takes every L2 transaction build on the head with it, and history replays
 * from the beginning on every reconnect, so a frame rejected once is rejected
 * forever: no verified session, no head clock, and every escrow operation on
 * that head fails closed.
 *
 * Falling back to plain `JSON.parse` would trade the throw for rounded integer
 * asset quantities above 2^53 - 1, which is the one thing this module exists to
 * prevent. So the fallback lifts only the offending literals out of the
 * document before parsing and puts their exact double values back afterwards.
 * Integers still go through json-bigint untouched.
 */
const FRACTION_PLACEHOLDER_PREFIX = ' hydra-fraction:';

/** json-bigint's own threshold, above which it reaches for `BigInt()`. */
const BIGINT_LITERAL_LENGTH = 15;

const JSON_NUMBER = /-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/y;

type LiftedFractions = { text: string; fractions: Map<string, number> };

/**
 * Replace every number literal json-bigint would hand to `BigInt()` and that
 * `BigInt()` cannot represent with a placeholder string.
 *
 * The scan is string-aware: such a literal inside a JSON string is data and is
 * left exactly as written. Outside a string the only tokens are structural
 * characters, `true`/`false`/`null` and numbers, so a digit or `-` there always
 * starts a number literal.
 */
function liftLongFractions(text: string): LiftedFractions {
	const fractions = new Map<string, number>();
	let out = '';
	let index = 0;
	let inString = false;

	while (index < text.length) {
		const char = text[index];
		if (inString) {
			if (char === '\\') {
				out += char + (text[index + 1] ?? '');
				index += 2;
				continue;
			}
			out += char;
			index += 1;
			if (char === '"') inString = false;
			continue;
		}
		if (char === '"') {
			inString = true;
			out += char;
			index += 1;
			continue;
		}
		if (char !== '-' && (char < '0' || char > '9')) {
			out += char;
			index += 1;
			continue;
		}

		JSON_NUMBER.lastIndex = index;
		const match = JSON_NUMBER.exec(text);
		if (match === null) {
			out += char;
			index += 1;
			continue;
		}
		const literal = match[0];
		index += literal.length;
		if (literal.length > BIGINT_LITERAL_LENGTH && /[.eE]/.test(literal)) {
			const placeholder = `${FRACTION_PLACEHOLDER_PREFIX}${fractions.size} `;
			fractions.set(placeholder, Number(literal));
			out += JSON.stringify(placeholder);
			continue;
		}
		out += literal;
	}

	return { text: out, fractions };
}

/** What json-bigint hands back: JSON, with integers past 2^53 - 1 as bigints. */
type ParsedJson = string | number | boolean | bigint | null | ParsedJson[] | { [key: string]: ParsedJson };

/** Put the lifted doubles back where their placeholders landed. */
function restoreLongFractions(value: ParsedJson, fractions: Map<string, number>): ParsedJson {
	if (typeof value === 'string') {
		const restored = fractions.get(value);
		return restored === undefined ? value : restored;
	}
	if (Array.isArray(value)) {
		return value.map((entry) => restoreLongFractions(entry, fractions));
	}
	if (typeof value === 'object' && value !== null) {
		for (const key of Object.keys(value)) {
			value[key] = restoreLongFractions(value[key], fractions);
		}
	}
	return value;
}

/** Parse Hydra JSON without rounding integer quantities above 2^53 - 1. */
export function parseHydraJson(value: string): unknown {
	try {
		return hydraJson.parse(value) as unknown;
	} catch (error) {
		// Malformed input reaches here too, and so does a document that already
		// contains the placeholder text — substituting into that one could not be
		// undone unambiguously. Neither is rescuable, and the caller should see
		// the original parse error rather than the retry's.
		if (value.includes(FRACTION_PLACEHOLDER_PREFIX)) throw error;
		const lifted = liftLongFractions(value);
		if (lifted.fractions.size === 0) throw error;
		let parsed: unknown;
		try {
			parsed = hydraJson.parse(lifted.text) as unknown;
		} catch {
			throw error;
		}
		return restoreLongFractions(parsed as ParsedJson, lifted.fractions);
	}
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
