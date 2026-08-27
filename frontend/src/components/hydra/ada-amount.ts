/**
 * Parse an ADA amount into a lovelace string.
 *
 * Built by concatenation rather than arithmetic: the API takes a decimal string
 * anyway, and multiplying by a million in floating point is how 0.1 ADA becomes
 * 99999.99999999999 lovelace. Nothing finer than one lovelace is accepted,
 * because nothing finer exists.
 *
 * Returns null for anything that is not a positive amount, which is what the
 * forms use to keep their submit button disabled.
 */
export function adaToLovelace(value: string): string | null {
  const trimmed = value.trim();
  if (!/^\d+(\.\d{1,6})?$/.test(trimmed)) {
    return null;
  }
  const [whole, fraction = ''] = trimmed.split('.');
  const lovelace = `${whole}${fraction.padEnd(6, '0')}`.replace(/^0+(?=\d)/, '');
  return lovelace === '0' ? null : lovelace;
}
