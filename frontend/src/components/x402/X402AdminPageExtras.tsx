import { useAppContext } from '@/lib/contexts/AppContext';
import { hasEvmChainLimit } from '@/lib/permissions';
import { useX402NetworksForSession } from '@/lib/hooks/useX402';
import { X402ChainLimitHint } from '@/components/x402/X402ChainLimitHint';
import { X402SetupGuide } from '@/components/x402/X402SetupGuide';

/** Shared setup guide (admins) and chain-limit hint (non-admin keys) for x402 pages. */
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

  return (
    <>
      {capabilities.canAdmin && <X402SetupGuide />}
      {showChainLimitHint && <X402ChainLimitHint />}
    </>
  );
}
