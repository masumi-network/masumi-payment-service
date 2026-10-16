/** Largest value a Postgres `bigint` column can hold. */
const MAX_INT8 = BigInt('9223372036854775807');

/**
 * Parse a numeric search string into a lovelace range for amount filtering.
 * Mirrors the backend's parseAmountSearchRange in src/utils/shared/queries.ts.
 *
 * Computed from the digit string directly — float math (parseFloat * 1e6)
 * produced inverted, empty ranges for values whose binary representation
 * rounds down (e.g. '1.005' gave min 1004999 > max 1004998, so an exact
 * 1.005 ADA transaction never matched its own search).
 */
export function parseAmountSearchRange(query: string): { min: bigint; max: bigint } | undefined {
  const numericMatch = query.match(/^(\d+)(?:\.(\d*))?$/);
  if (!numericMatch) return undefined;

  const whole = numericMatch[1];
  const fraction = numericMatch[2] ?? '';

  // More fractional digits than lovelace can represent: a non-zero tail can
  // never match an integer lovelace amount. Keep the "matches nothing"
  // semantics (an explicitly empty range) rather than dropping the filter.
  if (fraction.length > 6 && /[1-9]/.test(fraction.slice(6))) {
    return { min: BigInt(0), max: BigInt(-1) };
  }

  const paddedFraction = fraction.slice(0, 6).padEnd(6, '0');
  const min = BigInt(whole + paddedFraction);
  // The search value is a prefix: '1.5' matches [1.5, 1.6) ADA, '1' matches
  // [1, 2) ADA — the span is one unit of the least-significant entered digit.
  const spanDigits = fraction.length === 0 ? 6 : Math.max(0, 6 - fraction.length);
  const span = BigInt(10) ** BigInt(spanDigits);
  const max = min + span - BigInt(1);

  // `amount` is a Postgres bigint server-side, and a bound past its range is
  // rejected by the driver. Clamp the same way the backend does so the mirror
  // keeps agreeing with it for very long numeric queries.
  if (min > MAX_INT8) return { min: BigInt(0), max: BigInt(-1) };

  // Return BigInt: lovelace amounts routinely exceed 2^53 (whale ADA / native
  // tokens), so downcasting to Number here would silently misfilter large
  // values. Callers compare against parseAmountToBigInt(amount).
  return { min, max: max > MAX_INT8 ? MAX_INT8 : max };
}

/**
 * Parse an integer lovelace amount string into a BigInt, or null if it is not a
 * plain non-negative integer. Used by amount-range filters so a malformed or
 * empty amount string can't throw from a bare `BigInt(...)` call.
 */
export function parseAmountToBigInt(amount: string | null | undefined): bigint | null {
  if (amount == null || !/^\d+$/.test(amount)) return null;
  return BigInt(amount);
}
