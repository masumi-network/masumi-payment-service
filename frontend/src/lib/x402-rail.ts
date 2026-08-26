import type { X402Budget, X402Network, X402Wallet } from '@/lib/api/generated';
import type { NetworkType } from '@/lib/contexts/AppContext';

/**
 * Shared visual accent for the x402 (EVM) rail, so the selector badge, setup banner and
 * wizard stay in sync instead of each hardcoding the same indigo classes.
 */
export const X402_ACCENT = {
  badge:
    'border-indigo-300 bg-indigo-50 text-indigo-700 dark:border-indigo-900/60 dark:bg-indigo-950/30 dark:text-indigo-300',
  icon: 'text-indigo-600 dark:text-indigo-400',
} as const;

/**
 * The x402 (EVM) rail has no Cardano Network of its own; chains are grouped into the
 * active environment purely by their `isTestnet` flag — testnet chains belong to the
 * Cardano Preprod environment, mainnet chains to Mainnet. This pairing is the single
 * source of truth shared by the selector, the sidebar, and the setup banner.
 */
export function isTestnetEnv(network: NetworkType): boolean {
  return network === 'Preprod';
}

export function resolveX402ChainEnvironment(
  network: NetworkType,
  submittedIsTestnet: boolean,
  isEnvironmentLocked: boolean,
): boolean {
  return isEnvironmentLocked ? isTestnetEnv(network) : submittedIsTestnet;
}

/** Enabled EVM chains that belong to the given Cardano environment. */
export function chainsForEnv<T extends { isEnabled: boolean; isTestnet: boolean }>(
  chains: T[],
  network: NetworkType,
): T[] {
  const wantTestnet = isTestnetEnv(network);
  return chains.filter((chain) => chain.isEnabled && chain.isTestnet === wantTestnet);
}

/** Managed wallets structurally bound to one of the supplied x402 networks. */
export function walletsForNetworks(wallets: X402Wallet[], networks: X402Network[]): X402Wallet[] {
  const networkIds = new Set(networks.map((network) => network.id));
  return wallets.filter((wallet) => networkIds.has(wallet.networkId));
}

/** Payment Sources must keep drafts visible so operators can finish or remove their config. */
export function filterX402PaymentSourceChains<
  T extends Pick<X402Network, 'displayName' | 'caip2Id'>,
>(chains: T[], searchQuery: string): T[] {
  if (!searchQuery) return chains;
  const query = searchQuery.toLowerCase();
  return chains.filter(
    (chain) =>
      chain.displayName.toLowerCase().includes(query) ||
      chain.caip2Id.toLowerCase().includes(query),
  );
}

/** Whether any budget belongs to an enabled network in the supplied environment scope. */
export function hasBudgetOnEnabledNetworks(
  budgets: Pick<X402Budget, 'caip2Network'>[],
  networks: X402Network[],
): boolean {
  const enabledNetworkIds = new Set(
    networks.filter((network) => network.isEnabled).map((network) => network.caip2Id),
  );
  return budgets.some((budget) => enabledNetworkIds.has(budget.caip2Network));
}

/**
 * Whether a chain can actually serve x402 payments right now: enabled, reachable (RPC
 * URL set), and with either a self-hosted wallet or remote facilitator assigned. An enabled-but-
 * unconfigured chain (no facilitator / blank RPC) is not selectable as an active rail —
 * picking it should route to setup instead of pretending the rail works.
 *
 * Two projections reach this predicate. The admin one carries the raw config; the
 * pay-authenticated `/x402/networks/available` one withholds it and sends `canSettle`,
 * the server's own settlement verdict, instead.
 *
 * Dispatch on `canSettle` being present, NOT on config fields being absent: sniffing
 * `rpcUrl === undefined` means the day the admin projection starts sending `canSettle`
 * (or the available one starts sending `rpcUrl`) this predicate silently flips branch.
 * Preferring the server's verdict whenever it is present degrades safely instead.
 *
 * Caveat: `canSettle` only reports "facilitator wallet or URL present" — it does not
 * carry the RPC-reachability half of the admin check, so a facilitator-but-no-RPC chain
 * reads usable to a pay key and unusable to an admin. Widen `canSettle` server-side if
 * that divergence ever matters.
 */
export function isX402ChainUsable(chain: {
  isEnabled: boolean;
  canSettle?: boolean;
  facilitatorWalletId?: string | null;
  facilitatorUrl?: string | null;
  rpcUrl?: string | null;
}): boolean {
  if (typeof chain.canSettle === 'boolean') {
    return chain.isEnabled && chain.canSettle;
  }
  return (
    chain.isEnabled && (!!chain.facilitatorWalletId || !!chain.facilitatorUrl) && !!chain.rpcUrl
  );
}

/**
 * Whether the x402 rail is usable for the active environment: at least one chain in the
 * env group is fully operational (see isX402ChainUsable — enabled, facilitator, and RPC).
 * Uses the same bar as chain selection so a facilitator-but-no-RPC chain doesn't hide the
 * setup prompt while the rail still can't actually run payments.
 */
export function isX402SetUpForEnv(
  chains: Array<{
    isEnabled: boolean;
    isTestnet: boolean;
    canSettle?: boolean;
    facilitatorWalletId?: string | null;
    facilitatorUrl?: string | null;
    rpcUrl?: string | null;
  }>,
  network: NetworkType,
): boolean {
  return chainsForEnv(chains, network).some(isX402ChainUsable);
}
