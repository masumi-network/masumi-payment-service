import { useState } from 'react';
import { Plus, Pencil } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { CopyButton } from '@/components/ui/copy-button';
import { EmptyState } from '@/components/ui/empty-state';
import { HorizontalScrollArea } from '@/components/ui/horizontal-scroll-area';
import {
  tableActionsCellWideClass,
  tableActionsHeadWideClass,
} from '@/components/ui/table-actions-column';
import { Spinner } from '@/components/ui/spinner';
import { RefreshButton } from '@/components/RefreshButton';
import { useX402Networks, useX402Wallets } from '@/lib/hooks/useX402';
import { shortenAddress } from '@/lib/utils';
import { X402Network } from '@/lib/api/generated';

import { ChainDialog } from '@/components/x402/ChainForm';

export function ChainsTab() {
  const { networks, isLoading, isRefetching, refetch } = useX402Networks();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<X402Network | null>(null);

  const openCreate = () => {
    setEditing(null);
    setDialogOpen(true);
  };

  const openEdit = (network: X402Network) => {
    setEditing(network);
    setDialogOpen(true);
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          EVM chains available to the x402 payment rail. Testnet chains pair with the Preprod
          environment.
        </p>
        <div className="flex items-center gap-2">
          <RefreshButton onRefresh={refetch} isRefreshing={isRefetching} />
          <Button onClick={openCreate} className="flex items-center gap-2">
            <Plus className="h-4 w-4" />
            Add chain
          </Button>
        </div>
      </div>

      <HorizontalScrollArea className="border rounded-lg">
        <table className="w-full">
          <thead className="table-header-surface">
            <tr className="border-b">
              <th scope="col" className="p-4 text-left text-sm font-medium text-muted-foreground">
                Chain
              </th>
              <th scope="col" className="p-4 text-left text-sm font-medium text-muted-foreground">
                RPC URL
              </th>
              <th scope="col" className="p-4 text-left text-sm font-medium text-muted-foreground">
                Status
              </th>
              <th scope="col" className="p-4 text-left text-sm font-medium text-muted-foreground">
                Default asset
              </th>
              <th scope="col" className="p-4 text-left text-sm font-medium text-muted-foreground">
                Facilitator
              </th>
              <th scope="col" className={tableActionsHeadWideClass}>
                Actions
              </th>
            </tr>
          </thead>
          <tbody>
            {isLoading ? (
              <tr>
                <td colSpan={6} className="py-10">
                  <div className="flex justify-center">
                    <Spinner />
                  </div>
                </td>
              </tr>
            ) : networks.length === 0 ? (
              <tr>
                <td colSpan={6}>
                  <EmptyState
                    title="No chains configured"
                    description="Add an EVM chain to start accepting x402 payments."
                  />
                </td>
              </tr>
            ) : (
              networks.map((network) => (
                <tr key={network.id} className="group border-b last:border-0 hover:bg-row-hover">
                  <td className="p-4">
                    <div className="font-medium">{network.displayName}</div>
                    <div className="text-xs text-muted-foreground font-mono">{network.caip2Id}</div>
                  </td>
                  <td
                    className="p-4 text-sm font-mono max-w-[260px] truncate"
                    title={network.rpcUrl}
                  >
                    {network.rpcUrl}
                  </td>
                  <td className="p-4">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <Badge variant={network.isEnabled ? 'success' : 'secondary'}>
                        {network.isEnabled ? 'Enabled' : 'Disabled'}
                      </Badge>
                      <Badge variant="outline">{network.isTestnet ? 'Testnet' : 'Mainnet'}</Badge>
                    </div>
                  </td>
                  <td className="p-4 text-sm font-mono">
                    {network.defaultAsset ? (
                      <div className="flex items-center gap-1.5">
                        <span title={network.defaultAsset}>
                          {shortenAddress(network.defaultAsset, 6)}
                        </span>
                        {network.defaultAssetDecimals != null ? (
                          <span className="text-xs text-muted-foreground">
                            ({network.defaultAssetDecimals} decimals)
                          </span>
                        ) : (
                          <Badge variant="warning">Decimals needed</Badge>
                        )}
                        <CopyButton value={network.defaultAsset} />
                      </div>
                    ) : (
                      '—'
                    )}
                  </td>
                  <td className="p-4 text-sm">
                    {network.facilitatorUrl ? (
                      <span className="flex items-center gap-1.5">
                        <Badge variant="outline">Remote</Badge>
                        <span
                          className="font-mono text-xs max-w-[180px] truncate"
                          title={network.facilitatorUrl}
                        >
                          {network.facilitatorUrl}
                        </span>
                      </span>
                    ) : network.facilitatorWalletId ? (
                      <FacilitatorLabel
                        address={network.facilitatorWalletAddress}
                        walletId={network.facilitatorWalletId}
                      />
                    ) : (
                      <Badge variant="warning">Not set</Badge>
                    )}
                  </td>
                  <td className={tableActionsCellWideClass}>
                    <Button
                      variant="ghost"
                      size="sm"
                      aria-label="Edit chain"
                      onClick={() => openEdit(network)}
                    >
                      <Pencil className="h-4 w-4" />
                    </Button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </HorizontalScrollArea>

      <ChainDialog
        key={dialogOpen ? (editing?.id ?? 'new') : 'closed'}
        open={dialogOpen}
        editing={editing}
        onClose={() => {
          setDialogOpen(false);
          setEditing(null);
        }}
        onSaved={() => {
          setDialogOpen(false);
          setEditing(null);
          refetch();
        }}
      />
    </div>
  );
}

function FacilitatorLabel({ address, walletId }: { address: string | null; walletId: string }) {
  const { wallets } = useX402Wallets();
  if (address) return <span className="font-mono">{shortenAddress(address, 6)}</span>;
  const wallet = wallets.find((w) => w.id === walletId);
  const label = wallet?.note || (wallet?.address ? shortenAddress(wallet.address, 6) : null);
  return (
    <span className="font-mono" title={walletId}>
      {label ?? `${walletId.slice(0, 8)}…${walletId.slice(-4)}`}
    </span>
  );
}
