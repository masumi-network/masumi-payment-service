import type { NetworkType } from '@/lib/contexts/AppContext';

/**
 * Developers > Testing and transaction test shortcuts create real on-chain
 * escrows. Restrict to Preprod so Mainnet operators cannot trigger them by mistake.
 */
export function canUseTestPaymentTools(network: NetworkType): boolean {
  return network === 'Preprod';
}
