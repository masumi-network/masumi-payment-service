import { useAppContext } from '@/lib/contexts/AppContext';
import { hasEvmChainLimit } from '@/lib/permissions';
import { useX402NetworksForSession } from '@/lib/hooks/useX402';
import { X402ChainLimitHint } from '@/components/x402/X402ChainLimitHint';

/**
 * Chain-limit hint for non-admin keys on x402 pages. Admins get the setup prompt from
 * MainLayout instead.
 */
export function X402AdminPageExtras() {
  const { capabilities } = useAppContext();
  const { networks: sessionChains, isLoading: chainsLoading } = useX402NetworksForSession({
    silentErrors: true,
  });
  const showChainLimitHint =
    !capabilities.canAdmin &&
    !chainsLoading &&
    sessionChains.length === 0 &&
    !hasEvmChainLimit(capabilities.chainIdLimit);

  return showChainLimitHint ? <X402ChainLimitHint /> : null;
}
