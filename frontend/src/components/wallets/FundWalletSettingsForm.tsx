import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { Spinner } from '@/components/ui/spinner';

export type FundDistributionConfig = {
  id: string;
  enabled: boolean;
  batchWindowMs: number;
};

export type FundWalletSettingsSubmit = {
  enabled: boolean;
};

/**
 * A fund wallet is a funding source now, not a policy. Its only setting is
 * whether it is active. The trigger and amount for each top-up live on the hot
 * wallet's low-balance rules (open a wallet, edit its rules).
 */
export function FundWalletSettingsForm({
  config,
  onSubmit,
  isSubmitting,
}: {
  config: FundDistributionConfig;
  onSubmit: (values: FundWalletSettingsSubmit) => Promise<void>;
  isSubmitting: boolean;
}) {
  const [enabled, setEnabled] = useState(config.enabled);

  // Re-seed when the server value changes (after a save, or a background
  // refetch). Structural sharing keeps `config` stable when nothing changed.
  useEffect(() => {
    setEnabled(config.enabled);
  }, [config]);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    await onSubmit({ enabled });
  };

  return (
    <form onSubmit={submit} className="space-y-4">
      <div className="flex items-center justify-between rounded-md border p-3">
        <div>
          <p className="text-sm font-medium">Active funding source</p>
          <p className="text-xs text-muted-foreground">
            {enabled
              ? 'This wallet funds top-ups for wallets on this payment source.'
              : 'Paused. This wallet is not used for top-ups; its funds stay put.'}
          </p>
        </div>
        <Switch checked={enabled} onCheckedChange={setEnabled} aria-label="Toggle funding source" />
      </div>

      <p className="text-xs text-muted-foreground">
        Set when and how much to top up on each wallet: open a wallet and edit its low-balance
        rules.
      </p>

      <Button type="submit" disabled={isSubmitting} className="w-full">
        {isSubmitting ? <Spinner size={16} /> : 'Save settings'}
      </Button>
    </form>
  );
}
