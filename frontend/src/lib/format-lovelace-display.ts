import { formatSixDecimalAmount } from '@/lib/utils';

/** Format a lovelace amount as ADA for display, or a fallback when absent. */
export function formatLovelaceAsAda(
  amount: string | null | undefined,
  fallback = 'Default minimum',
): string {
  if (amount == null || amount === '') {
    return fallback;
  }
  return `${formatSixDecimalAmount(amount)} ADA`;
}
