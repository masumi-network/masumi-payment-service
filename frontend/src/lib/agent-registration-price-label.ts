/** Visible label for a fixed Masumi price amount field. */
export function getPriceAmountLabel(displayUnit: string): string {
  return `Amount (${displayUnit})`;
}

/** Accessible label tying the amount input to its selected coin. */
export function getPriceAmountAriaLabel(displayUnit: string, priceIndex: number): string {
  return `Amount in ${displayUnit} for Masumi price ${priceIndex + 1}`;
}
