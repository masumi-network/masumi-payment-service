/**
 * Convert a decimal amount string (e.g. '1.5' ADA) into integer base units
 * (e.g. '1500000' lovelace) using BigInt math.
 *
 * Handles negative amounts correctly: the sign is applied to the combined
 * value, not just the whole part (BigInt('-0') is 0, and '-1.5' must become
 * -1500000, not -1000000 + 500000). Fractional digits beyond `decimals` are
 * truncated; validate user input with `isValidDecimalAmount` first to reject
 * over-precise values instead of silently dropping them.
 *
 * @throws Error on non-decimal input (exponent notation like '1e5', empty
 * strings, stray characters) — `BigInt()` would otherwise throw an opaque
 * SyntaxError deep inside a submit handler.
 */
export function convertDecimalToBaseUnits(value: string, decimals: number = 6): string {
  const trimmed = value.trim();
  if (!/^-?(\d+(\.\d*)?|\.\d+)$/.test(trimmed)) {
    throw new Error(`Invalid decimal amount: ${value}`);
  }

  const isNegative = trimmed.startsWith('-');
  const unsigned = isNegative ? trimmed.slice(1) : trimmed;
  const [wholePart, fractionalPart = ''] = unsigned.split('.');
  const normalizedFractionalPart = fractionalPart.padEnd(decimals, '0').slice(0, decimals);
  const scale = BigInt(10) ** BigInt(decimals);
  const magnitude = BigInt(wholePart || '0') * scale + BigInt(normalizedFractionalPart || '0');

  return (isNegative ? -magnitude : magnitude).toString();
}

/**
 * Inverse of `convertDecimalToBaseUnits`: convert an integer base-unit string
 * (e.g. '1500000' lovelace) into a plain decimal string (e.g. '1.5') using
 * BigInt string math — `Number(value) / 1e6` silently loses precision above
 * Number.MAX_SAFE_INTEGER. No digit grouping and trailing fractional zeros are
 * trimmed, so the result is suitable for form input values that round-trip
 * through `convertDecimalToBaseUnits` without drift.
 *
 * @throws Error on non-integer input (decimal points, exponent notation,
 * stray characters) — mirrors the forward conversion's explicit failure mode.
 */
export function convertBaseUnitsToDecimal(value: string, decimals: number = 6): string {
  const trimmed = value.trim();
  if (!/^-?\d+$/.test(trimmed)) {
    throw new Error(`Invalid base unit amount: ${value}`);
  }

  const parsed = BigInt(trimmed);
  const isNegative = parsed < BigInt(0);
  const magnitude = isNegative ? -parsed : parsed;
  const scale = BigInt(10) ** BigInt(decimals);
  const whole = (magnitude / scale).toString();
  const fraction = (magnitude % scale).toString().padStart(decimals, '0').replace(/0+$/, '');
  const formatted = fraction.length > 0 ? `${whole}.${fraction}` : whole;

  return isNegative ? `-${formatted}` : formatted;
}

/**
 * Validate a decimal amount string before passing it to
 * `convertDecimalToBaseUnits`. Rejects exponent notation ('1e5'), values with
 * more fractional digits than the unit supports (which would be silently
 * truncated), and non-numeric input. Use in form schemas instead of
 * `parseFloat`-based checks, which accept all of the above.
 */
export function isValidDecimalAmount(
  value: string,
  options?: { decimals?: number; allowNegative?: boolean },
): boolean {
  const decimals = options?.decimals ?? 6;
  const trimmed = value.trim();
  const pattern = options?.allowNegative ? /^-?(\d+(\.\d*)?|\.\d+)$/ : /^(\d+(\.\d*)?|\.\d+)$/;
  if (!pattern.test(trimmed)) {
    return false;
  }
  const fractional = trimmed.split('.')[1] ?? '';
  return fractional.length <= decimals;
}
