/**
 * Parse a numeric search string into a lovelace range for amount filtering.
 * Mirrors the backend's parseAmountSearchRange in src/utils/shared/queries.ts.
 *
 * Computed from the digit string directly — float math (parseFloat * 1e6)
 * produced inverted, empty ranges for values whose binary representation
 * rounds down (e.g. '1.005' gave min 1004999 > max 1004998, so an exact
 * 1.005 ADA transaction never matched its own search).
 */
export function parseAmountSearchRange(query: string): { min: number; max: number } | undefined {
  const numericMatch = query.match(/^(\d+)(?:\.(\d*))?$/);
  if (!numericMatch) return undefined;

  const whole = numericMatch[1];
  const fraction = numericMatch[2] ?? '';

  // More fractional digits than lovelace can represent: a non-zero tail can
  // never match an integer lovelace amount. Keep the "matches nothing"
  // semantics (an explicitly empty range) rather than dropping the filter.
  if (fraction.length > 6 && /[1-9]/.test(fraction.slice(6))) {
    return { min: 0, max: -1 };
  }

  const paddedFraction = fraction.slice(0, 6).padEnd(6, '0');
  const min = BigInt(whole + paddedFraction);
  // The search value is a prefix: '1.5' matches [1.5, 1.6) ADA, '1' matches
  // [1, 2) ADA — the span is one unit of the least-significant entered digit.
  const spanDigits = fraction.length === 0 ? 6 : Math.max(0, 6 - fraction.length);
  const span = BigInt(10) ** BigInt(spanDigits);
  const max = min + span - BigInt(1);

  return { min: Number(min), max: Number(max) };
}
