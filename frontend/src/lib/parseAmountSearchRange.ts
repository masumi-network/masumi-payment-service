/**
 * Parse a numeric search string into a lovelace range for amount filtering.
 * Mirrors the backend's parseAmountSearchRange in src/utils/shared/queries.ts.
 */
export function parseAmountSearchRange(query: string): { min: number; max: number } | undefined {
  const numericMatch = query.match(/^(\d+\.?\d*)$/);
  if (!numericMatch) return undefined;

  const numericValue = parseFloat(numericMatch[1]);
  if (isNaN(numericValue) || numericValue < 0) return undefined;

  const hasDecimal = numericMatch[1].includes('.');
  if (hasDecimal) {
    const decimalDigits = numericMatch[1].split('.')[1].length;
    const precision = Math.pow(10, decimalDigits);
    const min = Math.floor(numericValue * 1000000);
    const nextStep = (Math.floor(numericValue * precision) + 1) / precision;
    const max = Math.floor(nextStep * 1000000) - 1;
    return { min, max };
  }

  const min = Math.floor(numericValue * 1000000);
  const max = Math.floor((numericValue + 1) * 1000000) - 1;
  return { min, max };
}
