import { Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  getRuleAssetMetaFromPreset,
  type RuleAssetPreset,
} from '@/components/wallets/wallet-details-utils';

/**
 * One asset's distribution policy as the operator edits it.
 *
 * Amounts are held as decimal strings in the asset's display unit (ADA, USDM…)
 * and converted to the smallest unit at submit. `preset` mirrors the vocabulary
 * low-balance rules already use, so the asset a rule watches and the asset a
 * top-up funds are named the same way.
 */
export type AssetRow = {
  key: string;
  preset: RuleAssetPreset;
  customAssetUnit: string;
  warningThreshold: string;
  criticalThreshold: string;
  topupAmount: string;
};

export function makeAssetRow(preset: RuleAssetPreset = 'lovelace'): AssetRow {
  return {
    // crypto.randomUUID is not for identity here — just a stable React key that
    // survives reordering, since assetUnit can be empty while being typed.
    key: crypto.randomUUID(),
    preset,
    customAssetUnit: '',
    warningThreshold: '',
    criticalThreshold: '',
    topupAmount: '',
  };
}

export function FundWalletAssetRows({
  rows,
  onChange,
  network,
  disabled,
}: {
  rows: AssetRow[];
  onChange: (rows: AssetRow[]) => void;
  network: 'Preprod' | 'Mainnet';
  disabled?: boolean;
}) {
  const update = (key: string, patch: Partial<AssetRow>) =>
    onChange(rows.map((row) => (row.key === key ? { ...row, ...patch } : row)));

  return (
    <div className="space-y-3">
      {rows.map((row) => {
        const meta = getRuleAssetMetaFromPreset(row.preset, network, row.customAssetUnit);
        const unitLabel = row.preset === 'custom' && !row.customAssetUnit ? 'token' : meta.label;

        return (
          <div key={row.key} className="space-y-2 rounded-md border p-3">
            <div className="flex items-center gap-2">
              <Select
                value={row.preset}
                onValueChange={(preset) => update(row.key, { preset: preset as RuleAssetPreset })}
                disabled={disabled}
              >
                <SelectTrigger className="h-8 flex-1">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="lovelace">ADA</SelectItem>
                  <SelectItem value="stablecoin">Stablecoin (USDM)</SelectItem>
                  <SelectItem value="custom">Custom token</SelectItem>
                </SelectContent>
              </Select>
              {rows.length > 1 && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-8 shrink-0 text-destructive hover:text-destructive"
                  onClick={() => onChange(rows.filter((candidate) => candidate.key !== row.key))}
                  disabled={disabled}
                  aria-label={`Remove ${unitLabel}`}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              )}
            </div>

            {row.preset === 'custom' && (
              <Input
                placeholder="Policy id + hex asset name"
                value={row.customAssetUnit}
                onChange={(event) => update(row.key, { customAssetUnit: event.target.value })}
                disabled={disabled}
              />
            )}

            <div className="grid grid-cols-3 gap-2">
              <div className="space-y-1">
                <label className="text-xs text-muted-foreground">Warning ({unitLabel})</label>
                <Input
                  value={row.warningThreshold}
                  onChange={(event) => update(row.key, { warningThreshold: event.target.value })}
                  disabled={disabled}
                />
              </div>
              <div className="space-y-1">
                <label className="text-xs text-muted-foreground">Critical ({unitLabel})</label>
                <Input
                  value={row.criticalThreshold}
                  onChange={(event) => update(row.key, { criticalThreshold: event.target.value })}
                  disabled={disabled}
                />
              </div>
              <div className="space-y-1">
                <label className="text-xs text-muted-foreground">Top-up ({unitLabel})</label>
                <Input
                  value={row.topupAmount}
                  onChange={(event) => update(row.key, { topupAmount: event.target.value })}
                  disabled={disabled}
                />
              </div>
            </div>

            {row.preset !== 'lovelace' && (
              <p className="text-xs text-muted-foreground">
                Sending a token also sends ~2 ADA with it — a token output cannot exist without ADA.
                The fund wallet needs both.
              </p>
            )}
          </div>
        );
      })}

      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => onChange([...rows, makeAssetRow('stablecoin')])}
        disabled={disabled}
      >
        Add asset
      </Button>
    </div>
  );
}
