'use client';

import { useRouter } from 'next/router';
import { FileInput, ChevronsUpDown, Settings, Check } from 'lucide-react';
import { cn, shortenAddress } from '@/lib/utils';
import { useAppContext } from '@/lib/contexts/AppContext';
import { usePaymentSourceExtendedAll } from '@/lib/hooks/usePaymentSourceExtendedAll';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuItem,
} from '@/components/ui/dropdown-menu';

const DEFAULT_CONTRACT_ADDRESSES: Record<string, string> = {
  Preprod: 'addr_test1wz7j4kmg2cs7yf92uat3ed4a3u97kr7axxr4avaz0lhwdsqukgwfm',
  Mainnet: 'addr1wx7j4kmg2cs7yf92uat3ed4a3u97kr7axxr4avaz0lhwdsq87ujx7',
};

interface NetworkSourceCardProps {
  collapsed: boolean;
  onNetworkChange: (network: 'Preprod' | 'Mainnet') => void;
}

export function NetworkSourceCard({ collapsed, onNetworkChange }: NetworkSourceCardProps) {
  const router = useRouter();
  const { selectedPaymentSourceId, setSelectedPaymentSourceId, selectedPaymentSource, network } =
    useAppContext();
  const { paymentSources } = usePaymentSourceExtendedAll();

  const networkSources = paymentSources.filter((ps) => ps.network === network);
  const isOnPaymentSourcesPage = router.pathname === '/payment-sources';
  const hasSources = networkSources.length > 0;

  const isDefaultContract = (address: string) => address === DEFAULT_CONTRACT_ADDRESSES[network];
  const selectedIsDefault =
    selectedPaymentSource && isDefaultContract(selectedPaymentSource.smartContractAddress);

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
              isDefaultContract={isDefaultContract}
              isOnPaymentSourcesPage={isOnPaymentSourcesPage}
            />
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
                <div
                  className={cn(
                    'text-xs truncate',
                    selectedPaymentSource && !selectedIsDefault && 'font-mono',
                  )}
                >
                  {selectedPaymentSource
                    ? selectedIsDefault
                      ? 'Default Contract'
                      : shortenAddress(selectedPaymentSource.smartContractAddress, 8)
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
            isDefaultContract={isDefaultContract}
            isOnPaymentSourcesPage={isOnPaymentSourcesPage}
          />
        </DropdownMenu>
      )}
    </div>
  );
}

function SourceDropdown({
  networkSources,
  selectedPaymentSourceId,
  setSelectedPaymentSourceId,
  isDefaultContract,
  isOnPaymentSourcesPage,
}: {
  networkSources: {
    id: string;
    smartContractAddress: string;
    feeRatePermille: number;
    PurchasingWallets?: { id: string }[];
    SellingWallets?: { id: string }[];
  }[];
  selectedPaymentSourceId: string | null;
  setSelectedPaymentSourceId: (id: string | null) => void;
  isDefaultContract: (address: string) => boolean;
  isOnPaymentSourcesPage: boolean;
}) {
  const router = useRouter();

  return (
    <DropdownMenuContent side="right" align="center" className="w-72">
      <DropdownMenuLabel>Payment Source</DropdownMenuLabel>
      {networkSources.map((source) => {
        const isSelected = source.id === selectedPaymentSourceId;
        const isDefault = isDefaultContract(source.smartContractAddress);
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
            <div className="flex flex-col gap-0.5">
              {isDefault ? (
                <span className="text-sm">Default Contract</span>
              ) : (
                <span className="font-mono text-sm">
                  {shortenAddress(source.smartContractAddress, 8)}
                </span>
              )}
              <span className="text-xs text-muted-foreground">
                {sourceWalletCount} {sourceWalletCount === 1 ? 'wallet' : 'wallets'}
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
