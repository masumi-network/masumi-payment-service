import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'react-toastify';
import { Plus, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { EmptyState } from '@/components/ui/empty-state';
import { Spinner } from '@/components/ui/spinner';
import { CopyButton } from '@/components/ui/copy-button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { RefreshButton } from '@/components/RefreshButton';
import { useAppContext } from '@/lib/contexts/AppContext';
import { useX402Wallets } from '@/lib/hooks/useX402';
import { handleApiCall, shortenAddress } from '@/lib/utils';
import { postX402Wallets, postX402WalletsDelete } from '@/lib/api/generated';

const PRIVATE_KEY_REGEX = /^0x[a-fA-F0-9]{64}$/;

export function WalletsTab() {
  const { apiClient } = useAppContext();
  const queryClient = useQueryClient();
  const { wallets, isLoading, isRefetching, refetch } = useX402Wallets();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [retiringId, setRetiringId] = useState<string | null>(null);

  const retireWallet = async (id: string) => {
    if (
      !window.confirm(
        'Retire this wallet? Its budgets are disabled and it is detached from any chain it facilitates. This cannot be undone.',
      )
    ) {
      return;
    }
    setRetiringId(id);
    await handleApiCall(() => postX402WalletsDelete({ client: apiClient, body: { id } }), {
      onSuccess: () => {
        toast.success('Wallet retired');
        refetch();
        // Retiring disables this wallet's budgets and detaches it as a chain facilitator,
        // so refresh those caches too — refetching only the wallet list leaves them stale.
        queryClient.invalidateQueries({ queryKey: ['x402-budgets'] });
        queryClient.invalidateQueries({ queryKey: ['x402-networks'] });
      },
      onFinally: () => setRetiringId(null),
      errorMessage: 'Failed to retire wallet',
    });
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          Managed EVM wallets fund outbound x402 payments and settle inbound ones. Private keys are
          stored encrypted and never leave the server.
        </p>
        <div className="flex items-center gap-2">
          <RefreshButton onRefresh={refetch} isRefreshing={isRefetching} />
          <Button onClick={() => setDialogOpen(true)} className="flex items-center gap-2">
            <Plus className="h-4 w-4" />
            Create wallet
          </Button>
        </div>
      </div>

      <div className="border rounded-lg overflow-x-auto">
        <table className="w-full">
          <thead>
            <tr className="border-b">
              <th className="p-4 text-left text-sm font-medium">Address</th>
              <th className="p-4 text-left text-sm font-medium">Wallet ID</th>
              <th className="p-4 text-left text-sm font-medium">Created</th>
              <th className="p-4 text-right text-sm font-medium">Actions</th>
            </tr>
          </thead>
          <tbody>
            {isLoading ? (
              <tr>
                <td colSpan={4} className="py-10">
                  <div className="flex justify-center">
                    <Spinner />
                  </div>
                </td>
              </tr>
            ) : wallets.length === 0 ? (
              <tr>
                <td colSpan={4}>
                  <EmptyState
                    title="No managed wallets"
                    description="Create a wallet to fund and settle x402 payments."
                  />
                </td>
              </tr>
            ) : (
              wallets.map((wallet) => (
                <tr key={wallet.id} className="border-b last:border-0">
                  <td className="p-4">
                    <div className="flex items-center gap-1">
                      <span className="font-mono text-sm" title={wallet.address}>
                        {shortenAddress(wallet.address, 8)}
                      </span>
                      <CopyButton value={wallet.address} />
                    </div>
                  </td>
                  <td className="p-4 font-mono text-xs text-muted-foreground">{wallet.id}</td>
                  <td className="p-4 text-sm text-muted-foreground">
                    {new Date(wallet.createdAt).toLocaleString()}
                  </td>
                  <td className="p-4 text-right">
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-destructive hover:text-destructive"
                      disabled={retiringId === wallet.id}
                      onClick={() => retireWallet(wallet.id)}
                    >
                      <Trash2 className="h-4 w-4" />
                      {retiringId === wallet.id ? 'Retiring…' : 'Retire'}
                    </Button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <CreateWalletDialog
        key={dialogOpen ? 'open' : 'closed'}
        open={dialogOpen}
        onClose={() => setDialogOpen(false)}
        onSaved={() => {
          setDialogOpen(false);
          refetch();
          // A newly created wallet becomes selectable as a budget target.
          queryClient.invalidateQueries({ queryKey: ['x402-budgets'] });
        }}
      />
    </div>
  );
}

export function CreateWalletDialog({
  open,
  onClose,
  onSaved,
}: {
  open: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { apiClient } = useAppContext();
  const [privateKey, setPrivateKey] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = privateKey.trim();
    if (trimmed && !PRIVATE_KEY_REGEX.test(trimmed)) {
      setError('Private key must be a 0x-prefixed 32-byte hex string');
      return;
    }
    setError(null);
    setIsSaving(true);
    await handleApiCall(
      () =>
        postX402Wallets({
          client: apiClient,
          body: trimmed ? { privateKey: trimmed } : {},
        }),
      {
        onSuccess: () => {
          toast.success('Wallet created');
          onSaved();
        },
        onFinally: () => setIsSaving(false),
        errorMessage: 'Failed to create wallet',
      },
    );
  };

  return (
    <Dialog open={open} onOpenChange={(value) => !value && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Create managed wallet</DialogTitle>
          <DialogDescription>
            Leave the private key empty to generate a fresh wallet. Any key you provide is stored
            encrypted and cannot be retrieved later.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={submit} className="space-y-4">
          <div className="space-y-2">
            <label className="text-sm font-medium">Private key (optional)</label>
            <Input
              type="password"
              placeholder="0x… (leave empty to generate)"
              className="font-mono"
              autoComplete="off"
              spellCheck={false}
              value={privateKey}
              onChange={(e) => setPrivateKey(e.target.value)}
            />
            {error && <p className="text-xs text-destructive">{error}</p>}
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose} disabled={isSaving}>
              Cancel
            </Button>
            <Button type="submit" disabled={isSaving}>
              {isSaving ? 'Creating…' : 'Create wallet'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
