import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { Spinner } from '@/components/ui/spinner';
import { FundWalletAssetRows, type AssetRow } from '@/components/wallets/FundWalletAssetRows';
import {
  getRuleAssetMeta,
  getRuleAssetMetaFromPreset,
} from '@/components/wallets/wallet-details-utils';
import { convertBaseUnitsToDecimal } from '@/lib/convertDecimalToBaseUnits';
import { buildAssetPolicyPayload, type AssetPolicyPayload } from '@/lib/fund-wallet-assets';

export type FundDistributionAssetConfig = {
  assetUnit: string;
  warningThreshold: string;
  criticalThreshold: string;
  topupAmount: string;
};

export type FundDistributionConfig = {
  id: string;
  enabled: boolean;
  batchWindowMs: number;
  Assets: FundDistributionAssetConfig[];
};

export type FundWalletSettingsSubmit = {
  enabled: boolean;
  Assets: AssetPolicyPayload[];
};

/**
 * Turn stored per-asset config back into editable rows.
 *
 * The stored assetUnit is the source of truth; `preset` is only how the row is
 * presented, so it is derived by matching the unit against the known ones.
 */
function toAssetRows(config: FundDistributionConfig, network: 'Preprod' | 'Mainnet'): AssetRow[] {
  const stablecoinUnit = getRuleAssetMetaFromPreset('stablecoin', network, '').assetUnit;

  return config.Assets.map((asset) => {
    const decimals = getRuleAssetMeta(asset.assetUnit, network).decimals ?? 0;
    const preset =
      asset.assetUnit === 'lovelace'
        ? ('lovelace' as const)
        : asset.assetUnit === stablecoinUnit
          ? ('stablecoin' as const)
          : ('custom' as const);

    return {
      key: asset.assetUnit,
      preset,
      customAssetUnit: preset === 'custom' ? asset.assetUnit : '',
      warningThreshold: convertBaseUnitsToDecimal(asset.warningThreshold, decimals),
      criticalThreshold: convertBaseUnitsToDecimal(asset.criticalThreshold, decimals),
      topupAmount: convertBaseUnitsToDecimal(asset.topupAmount, decimals),
    };
  });
}

export function FundWalletSettingsForm({
  config,
  onSubmit,
  isSubmitting,
  network,
}: {
  config: FundDistributionConfig;
  onSubmit: (values: FundWalletSettingsSubmit) => Promise<void>;
  isSubmitting: boolean;
  network: 'Preprod' | 'Mainnet';
}) {
  const [enabled, setEnabled] = useState(config.enabled);
  const [assetRows, setAssetRows] = useState<AssetRow[]>(() => toAssetRows(config, network));
  const [assetError, setAssetError] = useState<string | null>(null);

  // Re-seed when the server value changes (after a save, or a refetch from
  // another panel). TanStack Query's structural sharing keeps `config`'s
  // reference stable when nothing it contains changed, so a background refetch
  // does not clobber edits in progress.
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    setEnabled(config.enabled);
    setAssetRows(toAssetRows(config, network));
  }, [config, network]);
  /* eslint-enable react-hooks/set-state-in-effect */

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();

    const policy = buildAssetPolicyPayload(assetRows, network);
    if ('error' in policy) {
      setAssetError(policy.error);
      return;
    }
    setAssetError(null);

    await onSubmit({ enabled, Assets: policy.assets });
  };

  return (
    <form onSubmit={submit} className="space-y-4">
      <div className="flex items-center justify-between rounded-md border p-3">
        <div>
          <p className="text-sm font-medium">Automatic distribution</p>
          <p className="text-xs text-muted-foreground">
            {enabled
              ? 'Low wallets are topped up automatically.'
              : 'Paused. The wallet keeps its funds; nothing is sent.'}
          </p>
        </div>
        <Switch
          checked={enabled}
          onCheckedChange={setEnabled}
          aria-label="Toggle automatic distribution"
        />
      </div>

      <div className="space-y-2">
        <label className="text-sm font-medium">Assets to distribute</label>
        <p className="text-xs text-muted-foreground">
          Saving replaces the whole list — an asset removed here stops being topped up.
        </p>
        <FundWalletAssetRows
          rows={assetRows}
          onChange={setAssetRows}
          network={network}
          disabled={isSubmitting}
        />
        {assetError && <p className="text-xs text-destructive">{assetError}</p>}
      </div>

      <Button type="submit" disabled={isSubmitting} className="w-full">
        {isSubmitting ? <Spinner size={16} /> : 'Save settings'}
      </Button>
    </form>
  );
}
