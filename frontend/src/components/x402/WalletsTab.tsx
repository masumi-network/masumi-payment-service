import { useState } from 'react';
import { formatDateTime } from '@/lib/format-date';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'react-toastify';
import { Pencil, Plus, Trash2, Wallet as WalletIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { EmptyState } from '@/components/ui/empty-state';
import { HorizontalScrollArea } from '@/components/ui/horizontal-scroll-area';
import {
  tableActionsCellWideClass,
  tableActionsHeadWideClass,
} from '@/components/ui/table-actions-column';
import { Spinner } from '@/components/ui/spinner';
import { CopyButton } from '@/components/ui/copy-button';
import { RefreshButton } from '@/components/RefreshButton';
import { useAppContext } from '@/lib/contexts/AppContext';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { useAvailableX402Networks, useX402WalletsPaginated } from '@/lib/hooks/useX402';
import { shortenAddress } from '@/lib/utils';
import { useApiMutation } from '@/lib/hooks/useApiMutation';
import { postX402WalletsDelete, X402Wallet } from '@/lib/api/generated';
import { EditWalletNoteDialog } from '@/components/x402/WalletExtras';
import { WalletDetailsDialog, WalletLowBalanceBadge } from '@/components/x402/WalletDetailsDialog';
import { CreateWalletDialog } from '@/components/x402/wallet-setup/CreateWalletDialog';
import { formatX402WalletType } from '@/lib/display-labels';

type WalletType = X402Wallet['type'];

const walletTypeLabel = (type: WalletType) => formatX402WalletType(type);

export function WalletsTab() {
  const { apiClient, capabilities } = useAppContext();
  const queryClient = useQueryClient();
  const { wallets, isLoading, isRefetching, refetch, hasMore, isFetchingNextPage, loadMore } =
    useX402WalletsPaginated();
  const { networks } = useAvailableX402Networks({ silentErrors: true, allEnvironments: true });
  const chainLabel = (caip2: string) =>
    networks.find((network) => network.caip2Id === caip2)?.displayName ?? caip2;
  const [dialogOpen, setDialogOpen] = useState(false);
  const [retiringId, setRetiringId] = useState<string | null>(null);
  const [detailsWallet, setDetailsWallet] = useState<X402Wallet | null>(null);
  const [editWallet, setEditWallet] = useState<X402Wallet | null>(null);
  const [walletToRetire, setWalletToRetire] = useState<X402Wallet | null>(null);
  const canMutateWallets = capabilities.canAdmin;

  const retireWallet = useApiMutation({
    mutationFn: (body: { id: string }) => postX402WalletsDelete({ client: apiClient, body }),
    // Invalidate the whole 'x402-wallets' key space (paginated list AND the eager,
    // type-filtered picker queries used by the Chains/Alerts dialogs) so a
    // retired wallet disappears from every picker immediately, not after staleTime.
    // Retiring also detaches the wallet as a chain facilitator, and drops the
    // selling/purchasing counts the readiness contract reads, so refresh those
    // caches too.
    invalidateKeys: [['x402-wallets'], ['x402-networks'], ['rail-readiness']],
    errorMessage: 'Failed to retire wallet',
  });

  const confirmRetire = async () => {
    if (!walletToRetire) return;
    const id = walletToRetire.id;
    setRetiringId(id);
    const response = await retireWallet.mutateAsync({ id }).catch(() => null);
    setRetiringId(null);
    setWalletToRetire(null);
    if (!response) return;
    toast.success('Wallet retired');
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          Managed EVM wallets are split by direction: Purchasing wallets fund outbound x402
          payments, Selling wallets settle inbound ones as chain facilitators. Keys are encrypted at
          rest; generated keys are returned once for backup and imported keys are never echoed.
        </p>
        <div className="flex items-center gap-2">
          <RefreshButton onRefresh={refetch} isRefreshing={isRefetching} />
          {canMutateWallets && (
            <Button onClick={() => setDialogOpen(true)} className="flex items-center gap-2">
              <Plus className="h-4 w-4" />
              Create wallet
            </Button>
          )}
        </div>
      </div>

      <HorizontalScrollArea className="border rounded-lg">
        <table className="w-full">
          <thead className="table-header-surface">
            <tr className="border-b">
              <th scope="col" className="p-4 text-left text-sm font-medium text-muted-foreground">
                Address
              </th>
              <th scope="col" className="p-4 text-left text-sm font-medium text-muted-foreground">
                Type
              </th>
              <th scope="col" className="p-4 text-left text-sm font-medium text-muted-foreground">
                Network
              </th>
              <th scope="col" className="p-4 text-left text-sm font-medium text-muted-foreground">
                Note
              </th>
              <th scope="col" className="p-4 text-left text-sm font-medium text-muted-foreground">
                Created
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
            ) : wallets.length === 0 ? (
              <tr>
                <td colSpan={6}>
                  <EmptyState
                    title="No managed wallets"
                    description={
                      capabilities.canAdmin || !capabilities.x402WalletScopeEnabled
                        ? 'Create a wallet to fund and settle x402 payments.'
                        : 'No managed wallets are assigned to this API key. A scoped key only sees wallets an admin assigned to it. Ask an admin to assign one.'
                    }
                  />
                </td>
              </tr>
            ) : (
              wallets.map((wallet) => (
                <tr key={wallet.id} className="group border-b last:border-0 hover:bg-row-hover">
                  <td className="p-4">
                    <div className="flex items-center gap-1">
                      <span className="font-mono text-sm" title={wallet.address}>
                        {shortenAddress(wallet.address, 8)}
                      </span>
                      <CopyButton value={wallet.address} />
                    </div>
                  </td>
                  <td className="p-4 text-sm">{walletTypeLabel(wallet.type)}</td>
                  <td className="p-4 text-sm">{chainLabel(wallet.caip2Network)}</td>
                  <td className="p-4 text-sm text-muted-foreground">
                    {wallet.note || <span className="italic opacity-60">—</span>}
                  </td>
                  <td className="p-4 text-sm text-muted-foreground">
                    {formatDateTime(wallet.createdAt)}
                  </td>
                  <td className={tableActionsCellWideClass}>
                    <div className="flex items-center justify-end gap-1">
                      <Button variant="ghost" size="sm" onClick={() => setDetailsWallet(wallet)}>
                        <WalletIcon className="h-4 w-4" />
                        Details
                      </Button>
                      {capabilities.canAdmin && <WalletLowBalanceBadge walletId={wallet.id} />}
                      {canMutateWallets && (
                        <>
                          <Button
                            variant="ghost"
                            size="sm"
                            aria-label="Rename wallet"
                            onClick={() => setEditWallet(wallet)}
                          >
                            <Pencil className="h-4 w-4" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="text-destructive hover:text-destructive"
                            disabled={retiringId === wallet.id}
                            onClick={() => setWalletToRetire(wallet)}
                          >
                            <Trash2 className="h-4 w-4" />
                            {retiringId === wallet.id ? 'Retiring…' : 'Retire'}
                          </Button>
                        </>
                      )}
                    </div>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </HorizontalScrollArea>

      {hasMore && (
        <div className="flex justify-center">
          <Button variant="outline" onClick={loadMore} disabled={isFetchingNextPage}>
            {isFetchingNextPage ? 'Loading…' : 'Load more'}
          </Button>
        </div>
      )}

      <CreateWalletDialog
        key={dialogOpen ? 'open' : 'closed'}
        open={dialogOpen}
        onClose={() => setDialogOpen(false)}
        onSaved={() => {
          setDialogOpen(false);
          // Invalidate the whole 'x402-wallets' key space so the new wallet appears in the
          // list and in the type-filtered pickers (Chains facilitator, Alerts). A new
          // wallet also moves the readiness checks the setup surfaces read.
          queryClient.invalidateQueries({ queryKey: ['x402-wallets'] });
          queryClient.invalidateQueries({ queryKey: ['rail-readiness'] });
        }}
      />

      <WalletDetailsDialog
        key={detailsWallet ? `details-${detailsWallet.id}` : 'details-closed'}
        wallet={detailsWallet}
        open={detailsWallet != null}
        onClose={() => setDetailsWallet(null)}
        chainLabel={chainLabel}
      />

      <EditWalletNoteDialog
        key={editWallet ? `note-${editWallet.id}` : 'note-closed'}
        wallet={editWallet}
        open={editWallet != null}
        onClose={() => setEditWallet(null)}
        onSaved={() => {
          setEditWallet(null);
          queryClient.invalidateQueries({ queryKey: ['x402-wallets'] });
        }}
      />

      <ConfirmDialog
        open={walletToRetire !== null}
        onClose={() => setWalletToRetire(null)}
        title="Retire managed wallet"
        description="This detaches the wallet from any chain it facilitates, so a compromised key can no longer sign or settle. This cannot be undone."
        onConfirm={confirmRetire}
        isLoading={retiringId !== null && retiringId === walletToRetire?.id}
      />
    </div>
  );
}
