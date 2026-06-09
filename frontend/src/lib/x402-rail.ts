import type { X402Network } from '@/lib/api/generated';
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

/** Enabled EVM chains that belong to the given Cardano environment. */
export function chainsForEnv(chains: X402Network[], network: NetworkType): X402Network[] {
  const wantTestnet = isTestnetEnv(network);
  return chains.filter((chain) => chain.isEnabled && chain.isTestnet === wantTestnet);
}

/**
 * Whether a chain can actually serve x402 payments right now: enabled, reachable (RPC
 * URL set), and with a facilitator wallet assigned to settle on it. An enabled-but-
 * unconfigured chain (no facilitator / blank RPC) is not selectable as an active rail —
 * picking it should route to setup instead of pretending the rail works.
 */
export function isX402ChainUsable(chain: X402Network): boolean {
  return chain.isEnabled && !!chain.facilitatorWalletId && !!chain.rpcUrl;
}

/**
 * Whether the x402 rail is usable for the active environment. Mirrors how Cardano "is
 * set up" is inferred from existing DB rows: here we require at least one enabled chain
 * in the env group that has a facilitator wallet assigned (the receive side works).
 */
export function isX402SetUpForEnv(chains: X402Network[], network: NetworkType): boolean {
  return chainsForEnv(chains, network).some((chain) => !!chain.facilitatorWalletId);
}
