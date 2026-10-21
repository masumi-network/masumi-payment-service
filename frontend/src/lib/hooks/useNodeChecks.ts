import { useCallback, useMemo } from 'react';
import { useAppContext } from '@/lib/contexts/AppContext';
import { useRailReadiness } from '@/lib/hooks/useRailReadiness';
import { railOf } from '@/lib/rail-readiness';
import { useWallets, type WalletWithBalance } from '@/lib/queries/useWallets';
import { buildNodeChecks, type NodeWallet } from '@/lib/agent-validation/node-checks';

function toNodeWallets(wallets: readonly WalletWithBalance[]): NodeWallet[] {
  return wallets.map((wallet) => ({
    id: wallet.id,
    type: wallet.type,
    walletAddress: wallet.walletAddress,
    balanceLovelace: wallet.isBalanceUnavailable ? null : Number(wallet.balance),
    stablecoinBalance: wallet.isBalanceUnavailable ? null : Number(wallet.usdcxBalance),
  }));
}

/** Readiness plus wallet funding, as findings. Shared by the node check tool and the wizard's first step. */
export function useNodeChecks() {
  const { network } = useAppContext();
  const readiness = useRailReadiness({ silentErrors: true });
  const walletsQuery = useWallets();
  const { wallets, isLoading: walletsLoading, refetch: refetchWallets } = walletsQuery;
  const {
    cardano,
    isUnavailable,
    isLoading: readinessLoading,
    refetch: refetchReadiness,
  } = readiness;

  const checks = useMemo(
    () =>
      buildNodeChecks({
        network,
        rail: cardano,
        isReadinessUnavailable: isUnavailable,
        walletsLoaded: !walletsLoading,
        wallets: toNodeWallets(wallets),
      }),
    [network, cardano, isUnavailable, walletsLoading, wallets],
  );

  const refetch = useCallback(async () => {
    await Promise.all([refetchReadiness(), refetchWallets()]);
  }, [refetchReadiness, refetchWallets]);

  /** Refetches everything and returns the findings for the data just fetched, never for a stale render. */
  const runFresh = useCallback(async () => {
    const [freshReadiness, freshWallets] = await Promise.all([
      refetchReadiness(),
      refetchWallets(),
    ]);
    return buildNodeChecks({
      network,
      rail: railOf(freshReadiness.data ?? null, 'CardanoV2'),
      isReadinessUnavailable: freshReadiness.isError || freshReadiness.data == null,
      walletsLoaded: true,
      wallets: toNodeWallets(freshWallets.data?.wallets ?? []),
    });
  }, [network, refetchReadiness, refetchWallets]);

  return {
    checks,
    isLoading: readinessLoading || walletsLoading,
    isFetching: walletsQuery.isFetching,
    refetch,
    runFresh,
  };
}
