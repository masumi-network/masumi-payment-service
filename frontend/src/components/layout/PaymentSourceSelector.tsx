'use client';

import { useEffect, useMemo } from 'react';
import { useRouter } from 'next/router';
import { FileInput, ChevronsUpDown, Settings, Check, Coins, Wand2 } from 'lucide-react';
import { cn, shortenAddress } from '@/lib/utils';
import { useAppContext } from '@/lib/contexts/AppContext';
import { usePaymentSourceExtendedAll } from '@/lib/hooks/usePaymentSourceExtendedAll';
import { useX402Networks } from '@/lib/hooks/useX402';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuItem,
} from '@/components/ui/dropdown-menu';
import { PaymentSourceTypeBadge } from '@/components/payment-sources/PaymentSourceTypeBadge';
import {
  getPaymentSourceTypeShortLabel,
  sortPaymentSourcesByPreference,
  type PaymentSourceType,
} from '@/lib/payment-source-type';
import { chainsForEnv, isX402SetUpForEnv, X402_ACCENT } from '@/lib/x402-rail';
import type { X402Network } from '@/lib/api/generated';

interface NetworkSourceCardProps {
  collapsed: boolean;
  onNetworkChange: (network: 'Preprod' | 'Mainnet') => void;
}

/** Small pill that tells the two rails apart inside the selector. */
function RailBadge({ rail, className }: { rail: 'cardano' | 'x402'; className?: string }) {
  return (
    <Badge
      variant="outline"
      className={cn(
        'whitespace-nowrap px-1.5 py-0 text-[10px] font-medium',
        rail === 'x402'
          ? X402_ACCENT.badge
          : 'border-sky-300 bg-sky-50 text-sky-700 dark:border-sky-900/60 dark:bg-sky-950/30 dark:text-sky-300',
        className,
      )}
    >
      {rail === 'x402' ? 'EVM' : 'Cardano'}
    </Badge>
  );
}

export function NetworkSourceCard({ collapsed, onNetworkChange }: NetworkSourceCardProps) {
  const router = useRouter();
  const {
    selectedPaymentSourceId,
    setSelectedPaymentSourceId,
    selectedPaymentSource,
    network,
    activeRail,
    setActiveRail,
    selectedX402ChainId,
    setSelectedX402ChainId,
  } = useAppContext();
  const { paymentSources } = usePaymentSourceExtendedAll();
  const { networks: x402Networks, isLoading: x402Loading } = useX402Networks({
    silentErrors: true,
  });

  const networkSources = useMemo(
    () => sortPaymentSourcesByPreference(paymentSources.filter((ps) => ps.network === network)),
    [paymentSources, network],
  );
  const isOnPaymentSourcesPage = router.pathname === '/payment-sources';
  const hasSources = networkSources.length > 0;

  // EVM/x402 chains are payment rails within the selected Cardano environment.
  // Testnet chains pair with Preprod, mainnet chains with Mainnet. Memoized so the
  // selection-coherence effect below doesn't re-run on every render (new array ref).
  const evmChains = useMemo(() => chainsForEnv(x402Networks, network), [x402Networks, network]);
  const hasEvmChains = evmChains.length > 0;
  // Only advertise "needs setup" once data has actually loaded — the hook returns an
  // empty array before/while loading, which would otherwise flash the CTA on a
  // configured rail.
  const showSetupCta = !x402Loading && !isX402SetUpForEnv(x402Networks, network);

  const selectedChain = evmChains.find((chain) => chain.id === selectedX402ChainId) ?? null;

  // Keep the x402 selection coherent with what actually exists for the active env. The
  // sidebar (and therefore this component) mounts on every page, so this runs on every
  // route. Gated on the loaded state so a transient empty list during load/network-switch
  // never wrongly downgrades the rail.
  useEffect(() => {
    if (x402Loading) return;
    if (activeRail !== 'x402') return;
    if (selectedChain) return;
    if (hasEvmChains) {
      setSelectedX402ChainId(evmChains[0].id);
    } else {
      // No EVM chain for this env — fall back to the Cardano rail so the UI stays usable.
      setActiveRail('cardano');
      setSelectedX402ChainId(null);
    }
  }, [
    x402Loading,
    activeRail,
    selectedChain,
    hasEvmChains,
    evmChains,
    setSelectedX402ChainId,
    setActiveRail,
  ]);

  const selectCardanoSource = (id: string) => {
    setActiveRail('cardano');
    setSelectedPaymentSourceId(id);
  };
  const selectEvmChain = (id: string) => {
    setActiveRail('x402');
    setSelectedX402ChainId(id);
  };

  const triggerLabel =
    activeRail === 'x402'
      ? (selectedChain?.displayName ?? 'Select x402 chain')
      : selectedPaymentSource
        ? `${getPaymentSourceTypeShortLabel(selectedPaymentSource.paymentSourceType)} ${shortenAddress(
            selectedPaymentSource.smartContractAddress,
            8,
          )}`
        : 'Select source';

  const dropdown = (
    <SourceDropdown
      networkSources={networkSources}
      evmChains={evmChains}
      activeRail={activeRail}
      selectedPaymentSourceId={selectedPaymentSourceId}
      selectedX402ChainId={selectedX402ChainId}
      onSelectCardano={selectCardanoSource}
      onSelectEvm={selectEvmChain}
      showSetupCta={showSetupCta}
      isOnPaymentSourcesPage={isOnPaymentSourcesPage}
    />
  );

  // Also show the trigger when there's nothing selectable yet but x402 still needs setup,
  // so the "Set up x402 (EVM)" entry inside the dropdown stays reachable for EVM-only
  // operators with no Cardano source and no chains.
  const hasAnySelectable = hasSources || hasEvmChains || showSetupCta;

  if (collapsed) {
    return (
      <div className="flex flex-col items-center gap-1">
        <div className="grid grid-cols-2 p-1 bg-[#F4F4F5] dark:bg-secondary rounded-md gap-0.5">
          <Button
            variant="ghost"
            size="sm2"
            className={cn(
              'px-2 font-medium hover:scale-[1.03] transition-all duration-300',
              network === 'Preprod'
                ? 'bg-[#FFFFFFD0] dark:bg-background/70 hover:bg-[#FFFFFFD0] dark:hover:bg-background/70 cursor-default hover:scale-100 is-active'
                : 'bg-[#0000000a] dark:bg-[#ffffff0a] hover:bg-[#00000014] dark:hover:bg-[#ffffff14]',
            )}
            onClick={() => onNetworkChange('Preprod')}
          >
            P
          </Button>
          <Button
            variant="ghost"
            size="sm2"
            className={cn(
              'px-2 font-medium hover:scale-[1.03] transition-all duration-300',
              network === 'Mainnet'
                ? 'bg-[#FFFFFFD0] dark:bg-background/70 hover:bg-[#FFFFFFD0] dark:hover:bg-background/70 cursor-default hover:scale-100 is-active'
                : 'bg-[#0000000a] dark:bg-[#ffffff0a] hover:bg-[#00000014] dark:hover:bg-[#ffffff14]',
            )}
            onClick={() => onNetworkChange('Mainnet')}
          >
            M
          </Button>
        </div>
        {hasAnySelectable && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                className={cn(
                  'h-10 w-10 p-0 justify-center relative sidebar-active-indicator',
                  isOnPaymentSourcesPage && 'is-active',
                )}
                title={activeRail === 'x402' ? 'x402 (EVM) chain' : 'Payment Source'}
              >
                {activeRail === 'x402' ? (
                  <Coins className="h-4 w-4" />
                ) : (
                  <FileInput className="h-4 w-4" />
                )}
              </Button>
            </DropdownMenuTrigger>
            {dropdown}
          </DropdownMenu>
        )}
      </div>
    );
  }

  return (
    <div className="rounded-lg bg-[#F4F4F5] dark:bg-secondary p-1.5 flex flex-col gap-2">
      <div className="grid grid-cols-2 gap-1 mx-0.5">
        <Button
          variant="ghost"
          size="sm2"
          className={cn(
            'flex-1 font-medium hover:scale-[1.03] transition-all duration-300 truncate',
            network === 'Preprod'
              ? 'bg-[#FFFFFFD0] dark:bg-background/70 hover:bg-[#FFFFFFD0] dark:hover:bg-background/70 cursor-default hover:scale-100 is-active'
              : 'bg-[#0000000a] dark:bg-[#ffffff0a] hover:bg-[#00000014] dark:hover:bg-[#ffffff14]',
          )}
          onClick={() => onNetworkChange('Preprod')}
        >
          Preprod
        </Button>
        <Button
          variant="ghost"
          size="sm2"
          className={cn(
            'flex-1 font-medium hover:scale-[1.03] transition-all duration-300 truncate',
            network === 'Mainnet'
              ? 'bg-[#FFFFFFD0] dark:bg-background/70 hover:bg-[#FFFFFFD0] dark:hover:bg-background/70 cursor-default hover:scale-100 is-active'
              : 'bg-[#0000000a] dark:bg-[#ffffff0a] hover:bg-[#00000014] dark:hover:bg-[#ffffff14]',
          )}
          onClick={() => onNetworkChange('Mainnet')}
        >
          Mainnet
        </Button>
      </div>
      {hasAnySelectable && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              className={cn(
                'flex items-center gap-2 w-full rounded-md px-3 h-7',
                'hover:bg-[#00000008] dark:hover:bg-[#ffffff08]',
                'transition-colors duration-150 text-left cursor-pointer',
                'relative sidebar-active-indicator',
                isOnPaymentSourcesPage && 'is-active',
              )}
            >
              {activeRail === 'x402' ? (
                <Coins className="h-3.5 w-3.5 shrink-0" />
              ) : (
                <FileInput className="h-3.5 w-3.5 shrink-0" />
              )}
              <div className="flex-1 min-w-0">
                <div
                  className={cn(
                    'text-xs truncate',
                    activeRail !== 'x402' && selectedPaymentSource && 'font-mono',
                  )}
                >
                  {triggerLabel}
                </div>
              </div>
              <RailBadge rail={activeRail} />
              <ChevronsUpDown className="h-3 w-3 shrink-0 text-muted-foreground" />
            </button>
          </DropdownMenuTrigger>
          {dropdown}
        </DropdownMenu>
      )}
    </div>
  );
}

function SourceDropdown({
  networkSources,
  evmChains,
  activeRail,
  selectedPaymentSourceId,
  selectedX402ChainId,
  onSelectCardano,
  onSelectEvm,
  showSetupCta,
  isOnPaymentSourcesPage,
}: {
  networkSources: {
    id: string;
    smartContractAddress: string;
    paymentSourceType: PaymentSourceType;
    feeRatePermille: number;
    PurchasingWallets?: { id: string }[];
    SellingWallets?: { id: string }[];
  }[];
  evmChains: X402Network[];
  activeRail: 'cardano' | 'x402';
  selectedPaymentSourceId: string | null;
  selectedX402ChainId: string | null;
  onSelectCardano: (id: string) => void;
  onSelectEvm: (id: string) => void;
  showSetupCta: boolean;
  isOnPaymentSourcesPage: boolean;
}) {
  const router = useRouter();

  return (
    <DropdownMenuContent side="right" align="center" className="w-72">
      <DropdownMenuLabel className="flex items-center gap-2">
        Cardano
        <RailBadge rail="cardano" />
      </DropdownMenuLabel>
      {networkSources.length === 0 && (
        <div className="px-2 py-1.5 text-xs text-muted-foreground">No Cardano sources</div>
      )}
      {networkSources.map((source) => {
        const isSelected = activeRail === 'cardano' && source.id === selectedPaymentSourceId;
        const sourceWalletCount =
          (source.PurchasingWallets?.length ?? 0) + (source.SellingWallets?.length ?? 0);
        return (
          <DropdownMenuItem
            key={source.id}
            className="cursor-pointer flex items-center gap-2"
            onSelect={() => onSelectCardano(source.id)}
          >
            <Check
              className={cn(
                'h-4 w-4 shrink-0 transition-opacity duration-150',
                isSelected ? 'opacity-100' : 'opacity-0',
              )}
            />
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <div className="flex items-center gap-2">
                <PaymentSourceTypeBadge paymentSourceType={source.paymentSourceType} showDefault />
                <span className="font-mono text-sm">
                  {shortenAddress(source.smartContractAddress, 8)}
                </span>
              </div>
              <span className="text-xs text-muted-foreground">
                {sourceWalletCount} {sourceWalletCount === 1 ? 'wallet' : 'wallets'} ·{' '}
                {(source.feeRatePermille / 10).toFixed(1)}% fee
              </span>
            </div>
          </DropdownMenuItem>
        );
      })}

      {evmChains.length > 0 && (
        <>
          <DropdownMenuSeparator />
          <DropdownMenuLabel className="flex items-center gap-2">
            x402
            <RailBadge rail="x402" />
          </DropdownMenuLabel>
          {evmChains.map((chain) => {
            const isSelected = activeRail === 'x402' && chain.id === selectedX402ChainId;
            return (
              <DropdownMenuItem
                key={chain.id}
                className="cursor-pointer flex items-center gap-2"
                onSelect={() => onSelectEvm(chain.id)}
              >
                <Check
                  className={cn(
                    'h-4 w-4 shrink-0 transition-opacity duration-150',
                    isSelected ? 'opacity-100' : 'opacity-0',
                  )}
                />
                <div className="flex min-w-0 flex-1 flex-col gap-1">
                  <div className="flex items-center gap-2">
                    <span
                      className={cn(
                        'h-1.5 w-1.5 shrink-0 rounded-full',
                        chain.facilitatorWalletId ? 'bg-green-500' : 'bg-amber-500',
                      )}
                    />
                    <span className="truncate text-sm">{chain.displayName}</span>
                  </div>
                  <span className="text-xs text-muted-foreground">
                    <span className="font-mono">{chain.caip2Id}</span>
                    {!chain.facilitatorWalletId && (
                      <span className="text-amber-600 dark:text-amber-400">
                        {' · needs facilitator'}
                      </span>
                    )}
                  </span>
                </div>
              </DropdownMenuItem>
            );
          })}
        </>
      )}

      <DropdownMenuSeparator />
      {showSetupCta && (
        <DropdownMenuItem className="cursor-pointer" onSelect={() => router.push('/x402-setup')}>
          <Wand2 className="h-4 w-4 mr-2" />
          Set up x402 (EVM)
        </DropdownMenuItem>
      )}
      <DropdownMenuItem
        className={cn('cursor-pointer', isOnPaymentSourcesPage && 'bg-accent')}
        onSelect={() => router.push('/payment-sources')}
      >
        <Settings className="h-4 w-4 mr-2" />
        Edit payment sources
      </DropdownMenuItem>
    </DropdownMenuContent>
  );
}
