import type { NetworkType } from '@/lib/contexts/AppContext';

/**
 * Whether the Developers > Testing tools (and the shortcuts that lead to them)
 * are offered on this network.
 *
 * Those tools submit through the regular POST /payment and POST /purchase, so
 * on Mainnet they would create real payments with real funds. This is a UI
 * gate only; any server-side policy for test payments is decided separately.
 */
export function canUseTestPaymentTools(network: NetworkType): boolean {
  return network === 'Preprod';
}
