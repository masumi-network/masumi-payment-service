'use client';

import { useEffect, useMemo, type ReactNode } from 'react';
import { useRouter } from 'next/router';
import { FileInput, ChevronsUpDown, Settings, Check, Coins } from 'lucide-react';
import { cn, shortenAddress } from '@/lib/utils';
import { useAppContext } from '@/lib/contexts/AppContext';
import { usePaymentSourceExtendedAll } from '@/lib/hooks/usePaymentSourceExtendedAll';
import { useX402NetworksForSession, type X402SessionNetwork } from '@/lib/hooks/useX402';
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
import { chainsForEnv, isX402ChainUsable, isX402SetUpForEnv, X402_ACCENT } from '@/lib/x402-rail';
import { hasEvmChainLimit } from '@/lib/permissions';
import {
  CARDANO_ONLY_PATHS,
  isX402RailPath,
  X402_DASHBOARD_PATH,
  X402_SETUP_PATH,
} from '@/lib/x402-navigation';

interface NetworkSourceCardProps {
  collapsed: boolean;
  onNetworkChange: (network: 'Preprod' | 'Mainnet') => void;
}

// Routes that only make sense on one rail. Switching rails from one of these jumps to the
// new rail's home so the page content matches the picked context immediately, rather than
// waiting on the async redirect in _app (which is skipped while the chain query refetches).
/** Small pill that tells the two rails apart inside the selector. */
function RailBadge({
  rail,
  paymentSourceType,
  className,
}: {
  rail: 'cardano' | 'x402';
  paymentSourceType?: PaymentSourceType;
  className?: string;
}) {
  const label =
    rail === 'x402'
      ? 'EVM'
      : paymentSourceType
        ? `Cardano ${getPaymentSourceTypeShortLabel(paymentSourceType)}`
        : 'Cardano';

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
      {label}
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
    capabilities,
  } = useAppContext();
  const { paymentSources } = usePaymentSourceExtendedAll();
  const { networks: x402Networks, isLoading: x402Loading } = useX402NetworksForSession({
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
  const showSetupCta =
    capabilities.canAdmin && !x402Loading && !isX402SetUpForEnv(x402Networks, network);

  const selectedChain = evmChains.find((chain) => chain.id === selectedX402ChainId) ?? null;

  // Keep the x402 selection coherent with what actually exists for the active env. The
  // sidebar (and therefore this component) mounts on every page, so this runs on every
  // route. Gated on the loaded state so a transient empty list during load/network-switch
  // never wrongly downgrades the rail.
  useEffect(() => {
    if (x402Loading) return;
    if (activeRail !== 'x402') return;
    // Keep the selection only if it points at a *usable* chain. A persisted/stale id that
    // is enabled but half-configured (missing facilitator or RPC) must not pin the rail —
    // it isn't selectable in the dropdown, so upgrade to a usable chain when one exists.
    if (selectedChain && isX402ChainUsable(selectedChain)) return;
    if (!hasEvmChains) {
      // Setup must keep the EVM rail active while the first chain is still a draft or absent.
      if (router.pathname === X402_SETUP_PATH) return;
      // No EVM chain for this env — fall back to the Cardano rail so the UI stays usable.
      setActiveRail('cardano');
      setSelectedX402ChainId(null);
      if (isX402RailPath(router.pathname)) void router.replace('/');
      return;
    }
    const usable = evmChains.find(isX402ChainUsable);
    if (usable) {
      // Land on a chain the rail can actually act on, upgrading away from a half-configured
      // selection. Guarded so we don't re-set (and re-render) once already there.
      if (selectedX402ChainId !== usable.id) setSelectedX402ChainId(usable.id);
      return;
    }
    // No usable chain yet: keep the rail on an enabled chain so /x402 shows its setup
    // guide. Only set when nothing valid is selected, to avoid a render loop on the
    // half-configured selection we intentionally leave in place.
    if (!selectedChain) setSelectedX402ChainId(evmChains[0].id);
  }, [
    x402Loading,
    activeRail,
    selectedChain,
    selectedX402ChainId,
    hasEvmChains,
    evmChains,
    setSelectedX402ChainId,
    setActiveRail,
    router,
  ]);

  const selectCardanoSource = (id: string) => {
    setActiveRail('cardano');
    setSelectedPaymentSourceId(id);
    // Leave x402-only routes so the page matches the Cardano context we just switched to.
    if (isX402RailPath(router.pathname)) {
      router.push('/');
    }
  };
  const selectEvmChain = (id: string) => {
    setActiveRail('x402');
    setSelectedX402ChainId(id);
    // Leave Cardano-only routes so the page matches the x402 context we just switched to.
    if ((CARDANO_ONLY_PATHS as readonly string[]).includes(router.pathname)) {
      router.push(X402_DASHBOARD_PATH);
    }
  };

  const triggerLabel =
    activeRail === 'x402'
      ? // Only surface a chain name once it is fully configured; a chain still mid-setup
        // reads as "Set up x402" rather than masquerading as an active payment source.
        selectedChain && isX402ChainUsable(selectedChain)
        ? selectedChain.displayName
        : 'Set up x402'
      : selectedPaymentSource
        ? shortenAddress(selectedPaymentSource.smartContractAddress, 8)
        : 'Select source';

  const collapsedSourceLabel =
    activeRail === 'x402'
      ? 'Switch x402 (EVM) payment chain'
      : capabilities.canAdmin
        ? 'Switch or manage payment sources'
        : 'Switch payment source';

  const dropdown = (
    <SourceDropdown
      networkSources={networkSources}
      evmChains={evmChains}
      activeRail={activeRail}
      selectedPaymentSourceId={selectedPaymentSourceId}
      selectedX402ChainId={selectedX402ChainId}
      onSelectCardano={selectCardanoSource}
      onSelectEvm={selectEvmChain}
      isOnPaymentSourcesPage={isOnPaymentSourcesPage}
    />
  );

  // Also show the trigger when there's nothing selectable yet but x402 still needs setup,
  // so an EVM-only operator with no Cardano source and no chains can still open the
  // dropdown and reach "Manage payment sources" (and from there, setup).
  const hasAnySelectable = hasSources || hasEvmChains || showSetupCta;

  const networkButtonClass = (target: 'Preprod' | 'Mainnet') =>
    cn(
      'font-medium hover:scale-[1.03] transition-all duration-300',
      collapsed ? 'px-2' : 'flex-1 truncate',
      network === target
        ? 'bg-[#FFFFFFD0] dark:bg-background/70 hover:bg-[#FFFFFFD0] dark:hover:bg-background/70 cursor-default hover:scale-100 is-active'
        : 'bg-[#0000000a] dark:bg-[#ffffff0a] hover:bg-[#00000014] dark:hover:bg-[#ffffff14]',
    );

  const sourceIcon =
    activeRail === 'x402' ? (
      <Coins className="h-4 w-4 shrink-0" />
    ) : (
      <FileInput className="h-4 w-4 shrink-0" />
    );

  return (
    <div
      className={cn(
        'flex w-full flex-col',
        collapsed ? 'gap-1' : 'gap-1.5 rounded-lg bg-[#F4F4F5] p-1.5 pb-1 dark:bg-secondary',
      )}
    >
      <div
        className={cn(
          'grid grid-cols-2 rounded-md',
          collapsed ? 'gap-0.5 bg-[#F4F4F5] p-1 dark:bg-secondary' : 'mx-0.5 gap-1',
        )}
      >
        <Button
          variant="ghost"
          size="sm2"
          className={networkButtonClass('Preprod')}
          onClick={() => onNetworkChange('Preprod')}
        >
          <span className={cn(collapsed ? 'inline' : 'sr-only')}>P</span>
          <span className={cn(collapsed ? 'sr-only' : 'truncate')}>Preprod</span>
        </Button>
        <Button
          variant="ghost"
          size="sm2"
          className={networkButtonClass('Mainnet')}
          onClick={() => onNetworkChange('Mainnet')}
        >
          <span className={cn(collapsed ? 'inline' : 'sr-only')}>M</span>
          <span className={cn(collapsed ? 'sr-only' : 'truncate')}>Mainnet</span>
        </Button>
      </div>
      {hasAnySelectable && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className={cn(
                'flex items-center rounded-md relative sidebar-active-indicator transition-colors duration-150',
                collapsed
                  ? 'mx-auto h-10 w-10 shrink-0 justify-center'
                  : cn(
                      'h-10 w-full min-w-0 gap-3 px-3',
                      'border border-transparent hover:border-border/60',
                      'hover:bg-[#00000008] dark:hover:bg-[#ffffff08]',
                      'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
                      'text-left cursor-pointer',
                    ),
                isOnPaymentSourcesPage && 'is-active',
              )}
              title={collapsed ? collapsedSourceLabel : undefined}
              aria-label={collapsedSourceLabel}
            >
              {sourceIcon}
              {!collapsed && (
                <>
                  <div className="min-w-0 flex-1 overflow-hidden">
                    <div className="truncate text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                      Payment source
                    </div>
                    <div
                      className={cn(
                        'truncate text-xs',
                        activeRail !== 'x402' && selectedPaymentSource && 'font-mono',
                      )}
                    >
                      {triggerLabel}
                    </div>
                  </div>
                  <RailBadge
                    rail={activeRail}
                    paymentSourceType={
                      activeRail === 'cardano'
                        ? selectedPaymentSource?.paymentSourceType
                        : undefined
                    }
                    className="shrink-0"
                  />
                  <ChevronsUpDown className="h-4 w-4 shrink-0 text-muted-foreground" />
                </>
              )}
            </button>
          </DropdownMenuTrigger>
          {dropdown}
        </DropdownMenu>
      )}
    </div>
  );
}

/** Section title inside the payment-source picker (not duplicated with rail badges). */
function DropdownSectionLabel({
  children,
  trailing,
}: {
  children: ReactNode;
  trailing?: ReactNode;
}) {
  return (
    <DropdownMenuLabel className="flex items-center gap-2 px-2 py-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
      {children}
      {trailing}
    </DropdownMenuLabel>
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
  isOnPaymentSourcesPage,
}: {
  networkSources: {
    id: string;
    smartContractAddress: string;
    paymentSourceType: PaymentSourceType;
    feeRatePermille: number;
    PurchasingWalletsCount: number;
    SellingWalletsCount: number;
  }[];
  evmChains: X402SessionNetwork[];
  activeRail: 'cardano' | 'x402';
  selectedPaymentSourceId: string | null;
  selectedX402ChainId: string | null;
  onSelectCardano: (id: string) => void;
  onSelectEvm: (id: string) => void;
  isOnPaymentSourcesPage: boolean;
}) {
  const router = useRouter();
  const { capabilities } = useAppContext();
  // Only fully configured chains are offered as selectable payment sources; the rest are
  // surfaced as a single setup entry so the picker never lists a half-configured rail.
  const usableEvmChains = evmChains.filter(isX402ChainUsable);
  const hasUnconfiguredChains = evmChains.some((chain) => !isX402ChainUsable(chain));

  return (
    <DropdownMenuContent
      side="right"
      align="start"
      sideOffset={12}
      alignOffset={-74}
      collisionPadding={{ top: 8 }}
      className="w-72 p-1"
    >
      <DropdownSectionLabel>Cardano</DropdownSectionLabel>
      {networkSources.length === 0 && (
        <div className="px-2 py-2 text-xs text-muted-foreground">No sources on this network</div>
      )}
      {networkSources.map((source) => {
        const isSelected = activeRail === 'cardano' && source.id === selectedPaymentSourceId;
        const sourceWalletCount =
          (source.PurchasingWalletsCount ?? 0) + (source.SellingWalletsCount ?? 0);
        return (
          <DropdownMenuItem
            key={source.id}
            className="cursor-pointer flex items-start gap-2 rounded-md py-2"
            onSelect={() => onSelectCardano(source.id)}
          >
            <Check
              className={cn(
                'mt-0.5 h-4 w-4 shrink-0 transition-opacity duration-150',
                isSelected ? 'opacity-100' : 'opacity-0',
              )}
            />
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <div className="flex min-w-0 items-center gap-2">
                <PaymentSourceTypeBadge paymentSourceType={source.paymentSourceType} showDefault />
                <span className="truncate font-mono text-xs text-muted-foreground">
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

      {/* The chain projection is read-level, so every session that has EVM chains
          in its key limit sees the rail here. */}
      {evmChains.length === 0 &&
        !capabilities.canAdmin &&
        !hasEvmChainLimit(capabilities.chainIdLimit) && (
          <>
            <DropdownMenuSeparator className="my-1" />
            <DropdownSectionLabel trailing={<RailBadge rail="x402" />}>x402</DropdownSectionLabel>
            <div className="px-2 py-2 text-xs text-muted-foreground">
              This API key has no EVM chains in its chain limit, so none can be shown. An admin can
              add them to the key.
            </div>
          </>
        )}

      {evmChains.length > 0 && (
        <>
          <DropdownMenuSeparator className="my-1" />
          <DropdownSectionLabel trailing={<RailBadge rail="x402" />}>x402</DropdownSectionLabel>
          {/* Only fully configured chains are selectable payment sources. Chains still
              missing a facilitator or RPC aren't listed individually; they collapse into a
              single "set up" entry below so the picker only ever offers a ready rail. */}
          {usableEvmChains.map((chain) => {
            const isSelected = activeRail === 'x402' && chain.id === selectedX402ChainId;
            return (
              <DropdownMenuItem
                key={chain.id}
                className="cursor-pointer flex items-start gap-2 rounded-md py-2"
                onSelect={() => onSelectEvm(chain.id)}
              >
                <Check
                  className={cn(
                    'mt-0.5 h-4 w-4 shrink-0 transition-opacity duration-150',
                    isSelected ? 'opacity-100' : 'opacity-0',
                  )}
                />
                <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <div className="flex min-w-0 items-center gap-2">
                    <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-green-500" />
                    <span className="truncate text-sm font-medium">{chain.displayName}</span>
                  </div>
                  <span className="font-mono text-xs text-muted-foreground">{chain.caip2Id}</span>
                </div>
              </DropdownMenuItem>
            );
          })}
          {capabilities.canAdmin && hasUnconfiguredChains && (
            <DropdownMenuItem
              className="cursor-pointer flex items-center gap-2"
              onSelect={() => router.push('/x402-setup')}
            >
              <Coins className="h-4 w-4 shrink-0 text-muted-foreground" />
              <span className="text-sm">
                {usableEvmChains.length === 0 ? 'Set up x402 (EVM)' : 'Set up another chain'}
              </span>
            </DropdownMenuItem>
          )}
        </>
      )}

      {capabilities.canAdmin && (
        <>
          <DropdownMenuSeparator className="my-1" />
          <DropdownMenuItem
            className={cn('cursor-pointer rounded-md', isOnPaymentSourcesPage && 'bg-accent')}
            onSelect={() => router.push('/payment-sources')}
          >
            <Settings className="h-4 w-4 mr-2" />
            Manage payment sources
          </DropdownMenuItem>
        </>
      )}
    </DropdownMenuContent>
  );
}
