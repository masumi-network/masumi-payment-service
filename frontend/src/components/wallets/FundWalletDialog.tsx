import { useState } from 'react';
import { toast } from 'react-toastify';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
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

  const { fundWallet, isLoading } = useFundWallet();
  const { distributions, isLoading: isLoadingDistributions } = useFundDistributions(
    fundWallet?.id,
    {
      enabled: open && activeTab === 'Activity',
    },
  );
  const { createFundWallet, updateFundWallet, triggerDistribution } =
    useFundWalletMutations(selectedPaymentSourceId);

  const network = selectedPaymentSource?.network ?? 'Preprod';

  const handleCreate = async (values: FundWalletSetupSubmit) => {
    if (!selectedPaymentSourceId) return;
    await createFundWallet.mutateAsync({ ...values, paymentSourceId: selectedPaymentSourceId });
    toast.success('Fund wallet created. Send ADA to its address to start topping up.');
    onSuccess?.();
  };

  const handleUpdate = async (values: FundWalletSettingsSubmit) => {
    if (!fundWallet) return;
    await updateFundWallet.mutateAsync({ id: fundWallet.id, ...values });
    toast.success('Fund wallet settings saved');
    onSuccess?.();
  };

  const handleTrigger = async () => {
    await triggerDistribution.mutateAsync(undefined);
    // The endpoint returns before the cycle runs, so don't claim funds moved.
    toast.success('Distribution cycle triggered');
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
              fundWallet.FundDistributionConfig ? (
                <FundWalletSettingsForm
                  config={fundWallet.FundDistributionConfig}
                  onSubmit={handleUpdate}
                  isSubmitting={updateFundWallet.isPending}
                />
              ) : (
                <p className="py-6 text-center text-sm text-muted-foreground">
                  This fund wallet has no distribution config.
                </p>
              )
            ) : (
              <div className="space-y-3">
                <div className="flex justify-end">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={handleTrigger}
                    disabled={triggerDistribution.isPending}
                  >
                    {triggerDistribution.isPending ? <Spinner size={14} /> : 'Run cycle now'}
                  </Button>
                </div>
                <FundDistributionList
                  distributions={distributions}
                  isLoading={isLoadingDistributions}
                  network={network}
                />
              </div>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
