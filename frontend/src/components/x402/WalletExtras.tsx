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
import { handleApiCall } from '@/lib/utils';
import { getX402WalletsBalance, postX402WalletsUpdate, X402Wallet } from '@/lib/api/generated';

// Render a base-unit integer string at `decimals` precision, trimming trailing zeros, e.g.
// formatUnits("4200000", 6) -> "4.2". Pure string math to avoid float rounding.
function formatUnits(amount: string, decimals: number): string {
  if (decimals === 0) return amount;
  const negative = amount.startsWith('-');
  const digits = (negative ? amount.slice(1) : amount).padStart(decimals + 1, '0');
  const whole = digits.slice(0, digits.length - decimals);
  const fraction = digits.slice(digits.length - decimals).replace(/0+$/, '');
  return `${negative ? '-' : ''}${whole}${fraction ? `.${fraction}` : ''}`;
}

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
      return response?.data?.data?.Balances ?? [];
    },
    enabled: open && !!wallet && !!apiClient,
    staleTime: 15000,
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
                          {formatUnits(balance.native.amount, balance.native.decimals)}
                        </span>
                      </div>
                    )}
                    {balance.asset && (
                      <div className="flex items-center justify-between">
                        <span className="text-muted-foreground">
                          {balance.asset.symbol ?? 'Token'}
                        </span>
                        <span className="font-mono">
                          {formatUnits(balance.asset.amount, balance.asset.decimals)}
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
  const [isSaving, setIsSaving] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!wallet) return;
    setIsSaving(true);
    await handleApiCall(
      () =>
        postX402WalletsUpdate({
          client: apiClient,
          body: { id: wallet.id, note: note.trim() === '' ? null : note.trim() },
        }),
      {
        onSuccess: () => {
          toast.success('Wallet updated');
          onSaved();
        },
        onFinally: () => setIsSaving(false),
        errorMessage: 'Failed to update wallet',
      },
    );
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
