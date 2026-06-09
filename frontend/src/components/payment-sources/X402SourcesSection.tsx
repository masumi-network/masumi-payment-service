import { useMemo } from 'react';
import { useRouter } from 'next/router';
import { Coins, Wand2 } from 'lucide-react';
import { useAppContext, type NetworkType } from '@/lib/contexts/AppContext';
import { useX402Networks } from '@/lib/hooks/useX402';
import { isX402ChainUsable, X402_ACCENT } from '@/lib/x402-rail';
import { cn, shortenAddress } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { CopyButton } from '@/components/ui/copy-button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

/**
 * The x402 (EVM) half of the Payment Sources page. A configured chain is the EVM
 * equivalent of a Cardano payment source, so it belongs alongside them — but the two
 * data shapes differ enough (contract + fee + wallets vs chain + RPC + facilitator) that
 * they read as parallel sections rather than one mismatched table. Only fully configured
 * chains are listed as sources; anything still mid-setup routes through the wizard.
 */
export function X402SourcesSection({
  network,
  searchQuery,
}: {
  network: NetworkType;
  searchQuery: string;
}) {
  const router = useRouter();
  const { activeRail, selectedX402ChainId, setActiveRail, setSelectedX402ChainId } =
    useAppContext();
  // Bind chains to the env this section is rendered for (the page's Preprod/Mainnet
  // selection) rather than the ambient active network, so the list, header, and empty
  // state can never show one environment's chains while labelled with the other's.
  const { networks, isLoading } = useX402Networks({ silentErrors: true, network });

  // Only fully configured chains count as payment sources here, mirroring the rail picker.
  const usableChains = useMemo(() => networks.filter(isX402ChainUsable), [networks]);
  const hasUnconfigured = useMemo(
    () => networks.some((chain) => !isX402ChainUsable(chain)),
    [networks],
  );

  const filteredChains = useMemo(() => {
    if (!searchQuery) return usableChains;
    const query = searchQuery.toLowerCase();
    return usableChains.filter(
      (chain) =>
        chain.displayName.toLowerCase().includes(query) ||
        chain.caip2Id.toLowerCase().includes(query),
    );
  }, [usableChains, searchQuery]);

  const setActive = (chainId: string) => {
    setActiveRail('x402');
    setSelectedX402ChainId(chainId);
    router.push('/x402');
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <h2 className="text-sm font-semibold">x402 (EVM) chains</h2>
        <Badge
          variant="outline"
          className={cn('px-1.5 py-0 text-[10px] font-medium', X402_ACCENT.badge)}
        >
          EVM
        </Badge>
      </div>

      <div className="rounded-lg border overflow-x-auto">
        <table className="w-full">
          <thead className="bg-muted/30 dark:bg-muted/15">
            <tr className="border-b">
              <th
                scope="col"
                className="p-4 pl-6 text-left text-sm font-medium text-muted-foreground"
              >
                Chain
              </th>
              <th scope="col" className="p-4 text-left text-sm font-medium text-muted-foreground">
                RPC URL
              </th>
              <th scope="col" className="p-4 text-left text-sm font-medium text-muted-foreground">
                Facilitator
              </th>
              <th scope="col" className="w-20 p-4 pr-8"></th>
            </tr>
          </thead>
          <tbody>
            {isLoading ? (
              <tr>
                <td colSpan={4} className="p-6 text-center text-sm text-muted-foreground">
                  Loading chains…
                </td>
              </tr>
            ) : filteredChains.length === 0 ? (
              <tr>
                <td colSpan={4} className="p-8">
                  <div className="flex flex-col items-center gap-3 text-center">
                    <Coins className={cn('h-6 w-6', X402_ACCENT.icon)} />
                    <div className="space-y-1">
                      <p className="text-sm font-medium">
                        {searchQuery
                          ? 'No matching x402 chains'
                          : `No configured x402 chains for ${network}`}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {hasUnconfigured
                          ? 'A chain exists but still needs setup before it can be used.'
                          : 'Set up an EVM chain to accept and send stablecoin payments over x402.'}
                      </p>
                    </div>
                    {!searchQuery && (
                      <Button
                        size="sm"
                        onClick={() => router.push(`/x402-setup?network=${network}`)}
                      >
                        <Wand2 className="mr-2 h-4 w-4" />
                        Set up x402
                      </Button>
                    )}
                  </div>
                </td>
              </tr>
            ) : (
              filteredChains.map((chain) => {
                const isActive = activeRail === 'x402' && chain.id === selectedX402ChainId;
                return (
                  <tr
                    key={chain.id}
                    className={cn(
                      'border-b last:border-b-0',
                      isActive && 'bg-green-50 dark:bg-green-950/20',
                    )}
                  >
                    <td className={cn('p-4 pl-6', isActive && 'border-l-4 border-l-green-500')}>
                      <div className="text-sm font-medium">{chain.displayName}</div>
                      <div className="font-mono text-xs text-muted-foreground">{chain.caip2Id}</div>
                    </td>
                    <td className="p-4">
                      <div
                        className="max-w-[220px] truncate font-mono text-xs text-muted-foreground"
                        title={chain.rpcUrl}
                      >
                        {chain.rpcUrl}
                      </div>
                    </td>
                    <td className="p-4">
                      {chain.facilitatorWalletAddress ? (
                        <div className="flex items-center gap-2 font-mono text-xs">
                          {shortenAddress(chain.facilitatorWalletAddress, 6)}
                          <CopyButton value={chain.facilitatorWalletAddress} />
                        </div>
                      ) : (
                        <span className="text-xs text-muted-foreground">—</span>
                      )}
                    </td>
                    <td className="p-4 pr-8">
                      <div className="flex justify-end gap-2">
                        <Button variant="ghost" size="sm" onClick={() => router.push('/x402')}>
                          Manage
                        </Button>
                        {isActive ? (
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <Badge
                                variant="success"
                                className="flex items-center gap-1.5 px-3 py-1 cursor-help"
                              >
                                <span className="h-1.5 w-1.5 rounded-full bg-green-500 animate-subtle-pulse dark:bg-green-400" />
                                Active
                              </Badge>
                            </TooltipTrigger>
                            <TooltipContent>
                              <p className="max-w-[200px] text-sm">
                                This chain is the active x402 rail.
                              </p>
                            </TooltipContent>
                          </Tooltip>
                        ) : (
                          <Button variant="outline" size="sm" onClick={() => setActive(chain.id)}>
                            Set as Active
                          </Button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
