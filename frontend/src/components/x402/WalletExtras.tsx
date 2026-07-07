import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { toast } from 'react-toastify';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Spinner } from '@/components/ui/spinner';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { useAppContext } from '@/lib/contexts/AppContext';
import { formatX402Amount, handleApiCall } from '@/lib/utils';
import { useApiMutation } from '@/lib/hooks/useApiMutation';
import { getX402WalletsBalance, postX402WalletsUpdate, X402Wallet } from '@/lib/api/generated';

export function WalletBalanceDialog({
  wallet,
  open,
  onClose,
}: {
  wallet: X402Wallet | null;
  open: boolean;
  onClose: () => void;
}) {
  const { apiClient } = useAppContext();

  const query = useQuery({
    queryKey: ['x402-wallet-balance', wallet?.id],
    queryFn: async () => {
      const response = await handleApiCall(
        () => getX402WalletsBalance({ client: apiClient, query: { id: wallet!.id } }),
        { errorMessage: 'Failed to read balances' },
      );
      // handleApiCall returns null on failure (and toasts). Throw so the query enters its
      // error state rather than resolving to [] — otherwise a failed request is
      // indistinguishable from a wallet with no enabled chains.
      const balances = response?.data?.data?.Balances;
      if (balances == null) throw new Error('Failed to read balances');
      return balances;
    },
    enabled: open && !!wallet && !!apiClient,
    staleTime: 15000,
    // The error is already surfaced via toast + the dialog's error state; retrying would
    // re-toast on each attempt.
    retry: false,
  });

  const balances = query.data ?? [];

  return (
    <Dialog open={open} onOpenChange={(value) => !value && onClose()}>
      <DialogContent className="sm:max-w-[520px]">
        <DialogHeader>
          <DialogTitle>Wallet balances</DialogTitle>
          <DialogDescription className="break-all font-mono text-xs">
            {wallet?.address}
          </DialogDescription>
        </DialogHeader>

        {query.isLoading ? (
          <div className="flex justify-center py-10">
            <Spinner />
          </div>
        ) : query.isError ? (
          <p className="py-6 text-center text-sm text-destructive">
            Couldn&apos;t read balances. The request failed; try again.
          </p>
        ) : balances.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">
            No enabled chains to read balances from.
          </p>
        ) : (
          <div className="space-y-3">
            {balances.map((balance) => (
              <div key={balance.caip2Network} className="rounded-lg border p-3">
                <div className="mb-2 flex items-center justify-between">
                  <span className="text-sm font-medium">{balance.displayName}</span>
                  <span className="font-mono text-xs text-muted-foreground">
                    {balance.caip2Network}
                  </span>
                </div>
                {balance.error ? (
                  <p className="text-xs text-amber-600 dark:text-amber-400">{balance.error}</p>
                ) : (
                  <div className="space-y-1 text-sm">
                    {balance.native && (
                      <div className="flex items-center justify-between">
                        <span className="text-muted-foreground">{balance.native.symbol}</span>
                        <span className="font-mono">
                          {formatX402Amount(balance.native.amount, balance.native.decimals)}
                        </span>
                      </div>
                    )}
                    {balance.asset && (
                      <div className="flex items-center justify-between">
                        <span className="text-muted-foreground">
                          {balance.asset.symbol ?? 'Token'}
                        </span>
                        <span className="font-mono">
                          {formatX402Amount(balance.asset.amount, balance.asset.decimals)}
                        </span>
                      </div>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => query.refetch()} disabled={query.isFetching}>
            {query.isFetching ? 'Refreshing…' : 'Refresh'}
          </Button>
          <Button onClick={onClose}>Close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function EditWalletNoteDialog({
  wallet,
  open,
  onClose,
  onSaved,
}: {
  wallet: X402Wallet | null;
  open: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { apiClient } = useAppContext();
  const [note, setNote] = useState(wallet?.note ?? '');

  const updateWallet = useApiMutation({
    mutationFn: (body: { id: string; note: string | null }) =>
      postX402WalletsUpdate({ client: apiClient, body }),
    errorMessage: 'Failed to update wallet',
  });
  const isSaving = updateWallet.isPending;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!wallet) return;
    const response = await updateWallet
      .mutateAsync({ id: wallet.id, note: note.trim() === '' ? null : note.trim() })
      .catch(() => null);
    if (!response) return;
    toast.success('Wallet updated');
    onSaved();
  };

  return (
    <Dialog open={open} onOpenChange={(value) => !value && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Rename wallet</DialogTitle>
          <DialogDescription className="break-all font-mono text-xs">
            {wallet?.address}
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-4">
          <div className="space-y-2">
            <label className="text-sm font-medium">Note</label>
            <Input
              placeholder="e.g. Base facilitator"
              maxLength={250}
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose} disabled={isSaving}>
              Cancel
            </Button>
            <Button type="submit" disabled={isSaving}>
              {isSaving ? 'Saving…' : 'Save'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
