export type WalletFundStepBalance = {
  balance: string;
  isBalanceUnavailable?: boolean;
};

export type WalletFundStepInput = {
  isLoading: boolean;
  wallets: WalletFundStepBalance[];
};

/**
 * The welcome checklist "Fund a wallet" step completes only once at least one
 * wallet has a confirmed positive ADA balance. Loading and unavailable balances
 * never count as funded.
 */
export function isWalletFundStepComplete({ isLoading, wallets }: WalletFundStepInput): boolean {
  if (isLoading) {
    return false;
  }

  return wallets.some(
    (wallet) => !wallet.isBalanceUnavailable && BigInt(wallet.balance || '0') > BigInt(0),
  );
}
