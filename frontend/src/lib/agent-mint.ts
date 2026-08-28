/** Minimum lovelace a minting wallet must hold to register an agent (fees + min ADA). */
export const MIN_MINT_BALANCE_LOVELACE = 3_000_000;

export function minMintBalanceAda(): number {
  return MIN_MINT_BALANCE_LOVELACE / 1_000_000;
}

/** Mirrors the register dialog wallet picker: balances at or below the threshold are ineligible. */
export function hasSufficientMintBalance(balanceLovelace: number): boolean {
  return balanceLovelace > MIN_MINT_BALANCE_LOVELACE;
}
