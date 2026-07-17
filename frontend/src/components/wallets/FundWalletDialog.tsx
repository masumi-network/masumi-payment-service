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
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { CopyButton } from '@/components/ui/copy-button';
import { Spinner } from '@/components/ui/spinner';
import { Tabs } from '@/components/ui/tabs';
import { useAppContext } from '@/lib/contexts/AppContext';
import { useFundDistributions, useFundWallet } from '@/lib/queries/useFundWallet';
import { useFundWalletMutations } from '@/lib/hooks/useFundWalletMutations';
import { shortenAddress } from '@/lib/utils';
import { FundDistributionList } from '@/components/wallets/FundDistributionList';
import {
  FundWalletSettingsForm,
  type FundWalletSettingsSubmit,
} from '@/components/wallets/FundWalletSettingsForm';
import {
  FundWalletSetupForm,
  type FundWalletSetupSubmit,
} from '@/components/wallets/FundWalletSetupForm';

/**
 * Fund wallet management for the selected payment source.
 *
 * Two modes, chosen by whether a fund wallet exists: set one up, or manage the
 * existing one. Scoping is per payment source because that is how the server
 * models it -- a fund wallet belongs to exactly one source and can only pay
 * wallets on that source's network.
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
  const [activeTab, setActiveTab] = useState('Settings');

  const { fundWallet, isLoading, error, refetch } = useFundWallet();
  const {
    distributions,
    isLoading: isLoadingDistributions,
    error: distributionsError,
    refetch: refetchDistributions,
  } = useFundDistributions(fundWallet?.id, {
    enabled: open && activeTab === 'Activity',
    // The list is a live view of an async pipeline: "Run cycle now" returns
    // before any row exists, and Pending→Confirmed advances minutes later.
    // Without polling (global refetchOnWindowFocus is off) the panel froze at
    // whatever the first fetch saw.
    refetchInterval: 10_000,
  });

  // The dialog stays mounted on the wallets page, so without this the fund
  // wallet reflects the page-load state forever — hours-stale by the time the
  // dialog reopens, offering the setup form for an already-configured source.
  useEffect(() => {
    if (open) void refetch();
  }, [open, refetch]);
  const { createFundWallet, updateFundWallet, removeFundWallet, triggerDistribution } =
    useFundWalletMutations(selectedPaymentSourceId);
  const [isConfirmingDelete, setIsConfirmingDelete] = useState(false);

  const network = selectedPaymentSource?.network ?? 'Preprod';

  // useApiMutation already toasts on failure, but mutateAsync still rejects.
  // Swallow it here so a handled error doesn't surface as an unhandled rejection.
  const handleCreate = async (values: FundWalletSetupSubmit) => {
    if (!selectedPaymentSourceId) return;
    try {
      await createFundWallet.mutateAsync({ ...values, paymentSourceId: selectedPaymentSourceId });
      toast.success('Fund wallet created. Send ADA to its address to start topping up.');
      onSuccess?.();
    } catch {
      /* surfaced by useApiMutation's error toast */
    }
  };

  const handleUpdate = async (values: FundWalletSettingsSubmit) => {
    if (!fundWallet) return;
    try {
      await updateFundWallet.mutateAsync({ id: fundWallet.id, ...values });
      toast.success('Fund wallet settings saved');
      onSuccess?.();
    } catch {
      /* surfaced by useApiMutation's error toast */
    }
  };

  const handleDelete = async () => {
    if (!fundWallet) return;
    try {
      // Deliberately NOT forced. The server refuses while the wallet still holds
      // funds, and that 409 is the useful outcome — it tells the operator to
      // withdraw first, rather than silently stranding the balance.
      await removeFundWallet.mutateAsync({ id: fundWallet.id });
      toast.success('Fund wallet deleted');
      setIsConfirmingDelete(false);
      onSuccess?.();
      onClose();
    } catch {
      // The 409 ("still holds N lovelace, withdraw first") is surfaced by
      // useApiMutation's toast. Keep the confirm open so the message is read.
    }
  };

  const handleTrigger = async () => {
    try {
      const response = await triggerDistribution.mutateAsync(undefined);
      // Report what actually happened. The endpoint returns before the cycle
      // runs (so never claim funds moved), and when a cycle is already in
      // flight the trigger is a no-op — saying "triggered" would be a lie.
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

  return (
    <Dialog open={open} onOpenChange={(isOpen) => !isOpen && onClose()}>
      <DialogContent className="max-w-lg max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Fund wallet</DialogTitle>
          <DialogDescription>
            Automatically tops up the buying and selling wallets of this payment source.
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
              Could not load the fund wallet for this payment source.
            </p>
            <Button variant="outline" size="sm" onClick={() => void refetch()}>
              Retry
            </Button>
          </div>
        ) : !fundWallet ? (
          <FundWalletSetupForm onSubmit={handleCreate} isSubmitting={createFundWallet.isPending} />
        ) : (
          <div className="space-y-4">
            <div className="rounded-md border p-3">
              <p className="text-xs text-muted-foreground">Fund wallet address</p>
              <div className="mt-1 flex items-center gap-2">
                <span className="font-mono text-sm">
                  {shortenAddress(fundWallet.walletAddress)}
                </span>
                <CopyButton value={fundWallet.walletAddress} />
              </div>
              <p className="mt-2 text-xs text-muted-foreground">
                Send ADA here to keep the treasury funded.
              </p>
            </div>

            {fundWallet.LowBalanceSummary?.isLow && (
              <div className="rounded-md border border-amber-500/40 bg-amber-50 p-3 text-xs text-amber-700 dark:bg-amber-900/20 dark:text-amber-400">
                The fund wallet itself is low on funds. Top it up, or it cannot cover further
                distributions.
              </div>
            )}

            <Tabs
              tabs={[
                { name: 'Settings', count: null },
                { name: 'Activity', count: null },
              ]}
              activeTab={activeTab}
              onTabChange={setActiveTab}
            />

            {activeTab === 'Settings' ? (
              <div className="space-y-4">
                {fundWallet.FundDistributionConfig ? (
                  <FundWalletSettingsForm
                    config={fundWallet.FundDistributionConfig}
                    onSubmit={handleUpdate}
                    isSubmitting={updateFundWallet.isPending}
                  />
                ) : (
                  <p className="py-6 text-center text-sm text-muted-foreground">
                    This fund wallet has no distribution config.
                  </p>
                )}

                <div className="border-t pt-3">
                  <div className="flex items-center justify-between gap-3">
                    <p className="text-xs text-muted-foreground">
                      To stop top-ups temporarily, turn off automatic distribution above — deleting
                      is permanent and does not move funds.
                    </p>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="shrink-0 text-destructive hover:text-destructive"
                      onClick={() => setIsConfirmingDelete(true)}
                    >
                      Delete
                    </Button>
                  </div>
                </div>
              </div>
            ) : (
              <div className="space-y-3">
                <div className="flex justify-end">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={handleTrigger}
                    disabled={triggerDistribution.isPending}
                    // The endpoint is global by design — one scheduler cycle
                    // covers every fund wallet; money only moves where
                    // thresholds are breached. Say so instead of implying a
                    // per-source action.
                    title="Runs a distribution cycle across all fund wallets"
                  >
                    {triggerDistribution.isPending ? <Spinner size={14} /> : 'Run cycle now'}
                  </Button>
                </div>
                {distributionsError ? (
                  <div className="space-y-3 py-6 text-center">
                    <p className="text-sm text-muted-foreground">
                      Could not load fund distribution activity.
                    </p>
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
            )}
          </div>
        )}
      </DialogContent>

      <ConfirmDialog
        open={isConfirmingDelete}
        onClose={() => setIsConfirmingDelete(false)}
        title="Delete fund wallet?"
        description={
          'This does not move any funds. After deletion the mnemonic can no longer be exported, so withdraw the balance first — otherwise it is recoverable only with direct database access. Outstanding top-up requests are cancelled.'
        }
        onConfirm={() => void handleDelete()}
        isLoading={removeFundWallet.isPending}
        requireConfirmation
        confirmationText="DELETE"
        // Rendered inside the fund wallet dialog, so it needs to stack above it.
        elevatedChildStack
      />
    </Dialog>
  );
}
