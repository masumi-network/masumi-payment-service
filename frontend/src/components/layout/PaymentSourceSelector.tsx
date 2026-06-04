'use client';

import { useRouter } from 'next/router';
import { FileInput, ChevronsUpDown, Settings, Check, Coins } from 'lucide-react';
import { cn, shortenAddress } from '@/lib/utils';
import { useAppContext } from '@/lib/contexts/AppContext';
import { usePaymentSourceExtendedAll } from '@/lib/hooks/usePaymentSourceExtendedAll';
import { useX402Networks } from '@/lib/hooks/useX402';
import { Button } from '@/components/ui/button';
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

interface NetworkSourceCardProps {
  collapsed: boolean;
  onNetworkChange: (network: 'Preprod' | 'Mainnet') => void;
}

export function NetworkSourceCard({ collapsed, onNetworkChange }: NetworkSourceCardProps) {
  const router = useRouter();
  const { selectedPaymentSourceId, setSelectedPaymentSourceId, selectedPaymentSource, network } =
    useAppContext();
  const { paymentSources } = usePaymentSourceExtendedAll();
  const { networks: x402Networks } = useX402Networks({ silentErrors: true });

  const networkSources = sortPaymentSourcesByPreference(
    paymentSources.filter((ps) => ps.network === network),
  );
  const isOnPaymentSourcesPage = router.pathname === '/payment-sources';
  const hasSources = networkSources.length > 0;

  // EVM/x402 chains are payment rails within the selected Cardano environment.
  // Testnet chains pair with Preprod, mainnet chains with Mainnet.
  const activeEvmChains = x402Networks.filter(
    (chain) => chain.isEnabled && chain.isTestnet === (network === 'Preprod'),
  );

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
        {hasSources && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                className={cn(
                  'h-10 w-10 p-0 justify-center relative sidebar-active-indicator',
                  isOnPaymentSourcesPage && 'is-active',
                )}
                title="Payment Source"
              >
                <FileInput className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <SourceDropdown
              networkSources={networkSources}
              selectedPaymentSourceId={selectedPaymentSourceId}
              setSelectedPaymentSourceId={setSelectedPaymentSourceId}
              isOnPaymentSourcesPage={isOnPaymentSourcesPage}
            />
          </DropdownMenu>
        )}
        {activeEvmChains.length > 0 && (
          <Button
            variant="ghost"
            className="h-10 w-10 p-0 justify-center relative"
            title={`${activeEvmChains.length} x402 ${
              activeEvmChains.length === 1 ? 'chain' : 'chains'
            } active`}
            onClick={() => router.push('/x402')}
          >
            <Coins className="h-4 w-4" />
            <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-muted px-1 text-[10px] font-medium text-muted-foreground">
              {activeEvmChains.length}
            </span>
          </Button>
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
      {hasSources && (
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
              <FileInput className="h-3.5 w-3.5 shrink-0" />
              <div className="flex-1 min-w-0">
                <div className={cn('text-xs truncate', selectedPaymentSource && 'font-mono')}>
                  {selectedPaymentSource
                    ? `${getPaymentSourceTypeShortLabel(
                        selectedPaymentSource.paymentSourceType,
                      )} ${shortenAddress(selectedPaymentSource.smartContractAddress, 8)}`
                    : 'Select source'}
                </div>
              </div>
              <ChevronsUpDown className="h-3 w-3 shrink-0 text-muted-foreground" />
            </button>
          </DropdownMenuTrigger>
          <SourceDropdown
            networkSources={networkSources}
            selectedPaymentSourceId={selectedPaymentSourceId}
            setSelectedPaymentSourceId={setSelectedPaymentSourceId}
            isOnPaymentSourcesPage={isOnPaymentSourcesPage}
          />
        </DropdownMenu>
      )}
      {activeEvmChains.length > 0 && (
        <div className="mx-0.5 rounded-md bg-[#00000006] dark:bg-[#ffffff06] px-2 py-1.5">
          <button
            onClick={() => router.push('/x402')}
            className="flex w-full items-center justify-between text-[11px] font-medium uppercase tracking-wide text-muted-foreground hover:text-foreground transition-colors"
          >
            <span>x402 chains</span>
            <Settings className="h-3 w-3" />
          </button>
          <div className="mt-1 flex flex-col gap-1">
            {activeEvmChains.map((chain) => (
              <button
                key={chain.id}
                onClick={() => router.push('/x402')}
                className="flex items-center gap-2 rounded px-1 py-0.5 text-left transition-colors hover:bg-[#00000008] dark:hover:bg-[#ffffff08]"
                title={
                  chain.facilitatorWalletId
                    ? chain.caip2Id
                    : `${chain.caip2Id} · no facilitator wallet set`
                }
              >
                <span
                  className={cn(
                    'h-1.5 w-1.5 shrink-0 rounded-full',
                    chain.facilitatorWalletId ? 'bg-green-500' : 'bg-amber-500',
                  )}
                />
                <span className="truncate text-xs">{chain.displayName}</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function SourceDropdown({
  networkSources,
  selectedPaymentSourceId,
  setSelectedPaymentSourceId,
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
  selectedPaymentSourceId: string | null;
  setSelectedPaymentSourceId: (id: string | null) => void;
  isOnPaymentSourcesPage: boolean;
}) {
  const router = useRouter();

  return (
    <DropdownMenuContent side="right" align="center" className="w-72">
      <DropdownMenuLabel>Payment Source</DropdownMenuLabel>
      {networkSources.map((source) => {
        const isSelected = source.id === selectedPaymentSourceId;
        const sourceWalletCount =
          (source.PurchasingWallets?.length ?? 0) + (source.SellingWallets?.length ?? 0);
        return (
          <DropdownMenuItem
            key={source.id}
            className="cursor-pointer flex items-center gap-2"
            onSelect={() => setSelectedPaymentSourceId(source.id)}
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
      <DropdownMenuSeparator />
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
