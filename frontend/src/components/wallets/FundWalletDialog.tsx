import { useEffect, useState } from 'react';
import { toast } from 'react-toastify';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { Plus } from 'lucide-react';
import { useAppContext } from '@/lib/contexts/AppContext';
import { useFundDistributions, useFundWallet } from '@/lib/queries/useFundWallet';
import { useFundWalletMutations } from '@/lib/hooks/useFundWalletMutations';
import { FundDistributionList } from '@/components/wallets/FundDistributionList';
import { FundWalletCard } from '@/components/wallets/FundWalletCard';
import { type FundWalletSettingsSubmit } from '@/components/wallets/FundWalletSettingsForm';
import {
  FundWalletSetupForm,
  type FundWalletSetupSubmit,
} from '@/components/wallets/FundWalletSetupForm';

/**
 * Fund wallet management for the selected payment source.
 *
 * A source can have several fund wallets (redundancy / capacity): any of them
 * funds any shortage. The dialog lists them, lets the operator manage each, and
 * add more. Scoping is per payment source because that is how the server models
 * it, and a fund wallet can only pay wallets on its source's network.
 */
export function FundWalletDialog({
  open,
  onClose,
  onSuccess,
}: {
  open: boolean;
  onClose: () => void;
  onSuccess?: () => void;
}) {
  const { selectedPaymentSourceId, selectedPaymentSource } = useAppContext();
  // Gated on `open` so the wallets page doesn't fetch fund wallets on every
  // visit while this dialog stays closed (mirrors useFundDistributions below).
  const { fundWallets, isLoading, error, refetch } = useFundWallet({ enabled: open });
  const { createFundWallet, updateFundWallet, removeFundWallet, triggerDistribution } =
    useFundWalletMutations(selectedPaymentSourceId);
  const [isAdding, setIsAdding] = useState(false);
  const {
    distributions,
    isLoading: isLoadingDistributions,
    error: distributionError,
    refetch: refetchDistributions,
  } = useFundDistributions(
    { paymentSourceId: selectedPaymentSourceId },
    {
      enabled: open && fundWallets.length > 0,
      refetchInterval: 10_000,
    },
  );

  // The dialog stays mounted on the wallets page, so without this the list
  // reflects the page-load state forever, hours-stale by the time it reopens.
  useEffect(() => {
    if (open) void refetch();
  }, [open, refetch]);

  const network = selectedPaymentSource?.network ?? 'Preprod';

  // useApiMutation already toasts on failure, but mutateAsync still rejects.
  // Swallow it here so a handled error does not surface as an unhandled rejection.
  const handleCreate = async (values: FundWalletSetupSubmit) => {
    if (!selectedPaymentSourceId) return;
    try {
      await createFundWallet.mutateAsync({ ...values, paymentSourceId: selectedPaymentSourceId });
      toast.success('Fund wallet created. Send ADA to its address to start topping up.');
      setIsAdding(false);
      await refetch();
      onSuccess?.();
    } catch {
      /* surfaced by useApiMutation's error toast */
    }
  };

  const handleUpdate = async (id: string, values: FundWalletSettingsSubmit) => {
    try {
      await updateFundWallet.mutateAsync({ id, ...values });
      toast.success('Fund wallet settings saved');
      onSuccess?.();
    } catch {
      /* surfaced by useApiMutation's error toast */
    }
  };

  const handleDelete = async (id: string) => {
    try {
      // Deliberately NOT forced. The server refuses while the wallet still holds
      // funds, and that 409 is the useful outcome: it tells the operator to
      // withdraw first rather than silently stranding the balance.
      await removeFundWallet.mutateAsync({ id });
      toast.success('Fund wallet deleted');
      await refetch();
      onSuccess?.();
    } catch {
      // The 409 ("still holds N lovelace, withdraw first") is surfaced by the
      // mutation's toast; leave the row in place so the message is read.
      throw new Error('delete failed');
    }
  };

  const handleTrigger = async () => {
    try {
      const response = await triggerDistribution.mutateAsync(undefined);
      // The endpoint returns before the cycle runs (never claim funds moved), and
      // a cycle already in flight makes the trigger a no-op.
      const alreadyRunning = response?.data?.data?.alreadyRunning === true;
      toast.success(
        alreadyRunning
          ? 'A distribution cycle is already running'
          : 'Distribution cycle triggered for all fund wallets. Top-ups appear here once submitted.',
      );
    } catch {
      /* surfaced by useApiMutation's error toast */
    }
  };

  const hasWallets = fundWallets.length > 0;

  return (
    <Dialog
      open={open}
      onOpenChange={(isOpen) => {
        if (!isOpen) {
          // Collapse the add-form so it doesn't stay expanded on reopen or
          // carry over to another payment source's fund wallets.
          setIsAdding(false);
          onClose();
        }
      }}
    >
      <DialogContent className="max-w-lg max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Fund wallets</DialogTitle>
          <DialogDescription>
            Automatically top up the buying and selling wallets of this payment source. Any fund
            wallet here can cover any shortage.
          </DialogDescription>
        </DialogHeader>

        {isLoading ? (
          <div className="flex justify-center py-8">
            <Spinner size={20} />
          </div>
        ) : error ? (
          // Never fall through to the create form on a failed load: this source
          // may already have a funded treasury, and offering "create" would ask
          // for a seed phrase the server can only reject.
          <div className="space-y-3 py-6 text-center">
            <p className="text-sm text-muted-foreground">
              Could not load the fund wallets for this payment source.
            </p>
            <Button variant="outline" size="sm" onClick={() => void refetch()}>
              Retry
            </Button>
          </div>
        ) : !hasWallets && !isAdding ? (
          <FundWalletSetupForm
            onSubmit={handleCreate}
            isSubmitting={createFundWallet.isPending}
            network={network}
          />
        ) : (
          <div className="space-y-4">
            {fundWallets.map((fundWallet) => (
              <FundWalletCard
                key={fundWallet.id}
                fundWallet={fundWallet}
                onUpdate={handleUpdate}
                onDelete={handleDelete}
                isUpdating={
                  updateFundWallet.isPending && updateFundWallet.variables?.id === fundWallet.id
                }
                isDeleting={
                  removeFundWallet.isPending && removeFundWallet.variables?.id === fundWallet.id
                }
              />
            ))}

            <div className="space-y-3 rounded-lg border p-3">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <p className="text-sm font-medium">Top-up activity</p>
                  <p className="text-xs text-muted-foreground">
                    Includes queued requests before a fund wallet claims them.
                  </p>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => void handleTrigger()}
                  disabled={triggerDistribution.isPending}
                  title="Runs a distribution cycle across all fund wallets"
                >
                  {triggerDistribution.isPending ? <Spinner size={14} /> : 'Run cycle now'}
                </Button>
              </div>
              {distributionError ? (
                <div className="space-y-2 py-3 text-center">
                  <p className="text-sm text-muted-foreground">Could not load top-up activity.</p>
                  <Button variant="outline" size="sm" onClick={() => void refetchDistributions()}>
                    Retry
                  </Button>
                </div>
              ) : (
                <FundDistributionList
                  distributions={distributions}
                  isLoading={isLoadingDistributions}
                  network={network}
                />
              )}
            </div>

            {isAdding ? (
              <div className="space-y-3 rounded-lg border border-dashed p-3">
                <div className="flex items-center justify-between">
                  <p className="text-sm font-medium">Add a fund wallet</p>
                  <Button variant="ghost" size="sm" onClick={() => setIsAdding(false)}>
                    Cancel
                  </Button>
                </div>
                <FundWalletSetupForm
                  onSubmit={handleCreate}
                  isSubmitting={createFundWallet.isPending}
                  network={network}
                />
              </div>
            ) : (
              <Button variant="outline" className="w-full" onClick={() => setIsAdding(true)}>
                <Plus className="h-4 w-4" /> Add fund wallet
              </Button>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
