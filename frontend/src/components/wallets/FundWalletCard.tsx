import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { CopyButton } from '@/components/ui/copy-button';
import { shortenAddress } from '@/lib/utils';
import {
  FundWalletSettingsForm,
  type FundDistributionConfig,
  type FundWalletSettingsSubmit,
} from '@/components/wallets/FundWalletSettingsForm';

export type FundWalletItem = {
  id: string;
  walletAddress: string;
  LowBalanceSummary?: { isLow?: boolean } | null;
  FundDistributionConfig?: FundDistributionConfig | null;
};

/**
 * Manage a single fund wallet: its address, distribution settings, activity, and
 * deletion. Distribution requests are source-level and may be unassigned, so
 * their activity is rendered once by the parent instead of being hidden behind
 * an individual fund-wallet filter.
 */
export function FundWalletCard({
  fundWallet,
  onUpdate,
  onDelete,
  isUpdating,
  isDeleting,
}: {
  fundWallet: FundWalletItem;
  onUpdate: (id: string, values: FundWalletSettingsSubmit) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
  isUpdating: boolean;
  isDeleting: boolean;
}) {
  const [isConfirmingDelete, setIsConfirmingDelete] = useState(false);

  return (
    <div className="space-y-4 rounded-lg border p-3">
      <div className="rounded-md border p-3">
        <p className="text-xs text-muted-foreground">Fund wallet address</p>
        <div className="mt-1 flex items-center gap-2">
          <span className="font-mono text-sm">{shortenAddress(fundWallet.walletAddress)}</span>
          <CopyButton value={fundWallet.walletAddress} />
        </div>
        <p className="mt-2 text-xs text-muted-foreground">
          Send ADA here to keep the treasury funded.
        </p>
      </div>

      {fundWallet.LowBalanceSummary?.isLow && (
        <div className="rounded-md border border-amber-500/40 bg-amber-50 p-3 text-xs text-amber-700 dark:bg-amber-900/20 dark:text-amber-400">
          This fund wallet is low on funds. Top it up, or it cannot cover further distributions.
        </div>
      )}

      <div className="space-y-4">
        {fundWallet.FundDistributionConfig ? (
          <FundWalletSettingsForm
            config={fundWallet.FundDistributionConfig}
            onSubmit={(values) => onUpdate(fundWallet.id, values)}
            isSubmitting={isUpdating}
          />
        ) : (
          <p className="py-6 text-center text-sm text-muted-foreground">
            This fund wallet has no distribution config.
          </p>
        )}

        <div className="border-t pt-3">
          <div className="flex items-center justify-between gap-3">
            <p className="text-xs text-muted-foreground">
              To stop top-ups temporarily, turn off automatic distribution above. Deleting is
              permanent and does not move funds.
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

      <ConfirmDialog
        open={isConfirmingDelete}
        onClose={() => setIsConfirmingDelete(false)}
        title="Delete fund wallet?"
        description="This does not move funds. After deletion the mnemonic can no longer be exported, so withdraw every asset first. Queued top-ups continue through another enabled fund wallet, or are cancelled if none remains."
        onConfirm={() => {
          // On success close the confirm; on failure (e.g. 409 still-holds-funds)
          // keep it open so the toast is read. The mutation already toasted.
          void onDelete(fundWallet.id)
            .then(() => setIsConfirmingDelete(false))
            .catch(() => {});
        }}
        isLoading={isDeleting}
        requireConfirmation
        confirmationText="DELETE"
        elevatedChildStack
      />
    </div>
  );
}
