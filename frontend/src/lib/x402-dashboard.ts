export type X402DashboardBalanceRead = {
  walletId: string;
  requestFailed: boolean;
  balances: Array<{
    caip2Network: string;
    displayName: string;
    native: { symbol: string; decimals: number; amount: string } | null;
    asset: { asset: string; symbol: string | null; decimals: number; amount: string } | null;
    error: string | null;
  }>;
};

export type X402DashboardBalance = {
  caip2Network: string;
  displayName: string;
  asset: 'native' | string;
  symbol: string;
  decimals: number;
  amount: string;
  walletCount: number;
};

type MutableBalance = Omit<X402DashboardBalance, 'amount' | 'walletCount'> & {
  amount: bigint;
  walletIds: Set<string>;
};

export function aggregateX402DashboardBalances(reads: X402DashboardBalanceRead[]): {
  balances: X402DashboardBalance[];
  failedReadCount: number;
} {
  const grouped = new Map<string, MutableBalance>();
  const invalidAssetKeys = new Set<string>();
  let failedReadCount = 0;

  const addAmount = (
    read: X402DashboardBalanceRead,
    balance: X402DashboardBalanceRead['balances'][number],
    asset: 'native' | string,
    symbol: string,
    decimals: number,
    amount: string,
  ) => {
    let atomicAmount: bigint;
    try {
      atomicAmount = BigInt(amount);
    } catch {
      failedReadCount += 1;
      return;
    }

    const normalizedAsset = asset === 'native' ? asset : asset.toLowerCase();
    const key = `${balance.caip2Network}:${normalizedAsset}`;
    if (invalidAssetKeys.has(key)) {
      failedReadCount += 1;
      return;
    }
    const existing = grouped.get(key);
    if (existing) {
      if (existing.decimals !== decimals) {
        failedReadCount += existing.walletIds.size + 1;
        grouped.delete(key);
        invalidAssetKeys.add(key);
        return;
      }
      existing.amount += atomicAmount;
      existing.walletIds.add(read.walletId);
      return;
    }

    grouped.set(key, {
      caip2Network: balance.caip2Network,
      displayName: balance.displayName,
      asset: normalizedAsset,
      symbol,
      decimals,
      amount: atomicAmount,
      walletIds: new Set([read.walletId]),
    });
  };

  for (const read of reads) {
    if (read.requestFailed) {
      failedReadCount += 1;
      continue;
    }

    for (const balance of read.balances) {
      if (balance.error) {
        failedReadCount += 1;
        continue;
      }
      if (balance.native) {
        addAmount(
          read,
          balance,
          'native',
          balance.native.symbol,
          balance.native.decimals,
          balance.native.amount,
        );
      }
      if (balance.asset) {
        addAmount(
          read,
          balance,
          balance.asset.asset,
          balance.asset.symbol ?? 'Token',
          balance.asset.decimals,
          balance.asset.amount,
        );
      }
    }
  }

  const balances = Array.from(grouped.values())
    .map(({ amount, walletIds, ...balance }) => ({
      ...balance,
      amount: amount.toString(),
      walletCount: walletIds.size,
    }))
    .sort(
      (left, right) =>
        left.caip2Network.localeCompare(right.caip2Network) ||
        left.symbol.localeCompare(right.symbol) ||
        left.asset.localeCompare(right.asset),
    );

  return { balances, failedReadCount };
}
