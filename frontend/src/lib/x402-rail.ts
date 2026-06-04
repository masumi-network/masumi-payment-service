import type { X402Network } from '@/lib/api/generated';
import type { NetworkType } from '@/lib/contexts/AppContext';

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
 * Whether the x402 rail is usable for the active environment. Mirrors how Cardano "is
 * set up" is inferred from existing DB rows: here we require at least one enabled chain
 * in the env group that has a facilitator wallet assigned (the receive side works).
 */
export function isX402SetUpForEnv(chains: X402Network[], network: NetworkType): boolean {
  return chainsForEnv(chains, network).some((chain) => !!chain.facilitatorWalletId);
}
