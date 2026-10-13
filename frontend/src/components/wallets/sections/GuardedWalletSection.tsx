import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Spinner } from '@/components/ui/spinner';
import { WalletLink } from '@/components/ui/wallet-link';
import { formatLovelaceAsAda } from '@/lib/format-lovelace-display';
import type { GetWalletGuardedResponses } from '@/lib/api/generated';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import type { GuardedAttachForm } from '@/components/wallets/useGuardedWallet';
import { assetLabelOf, governableAssets, LOVELACE } from '@/components/wallets/guarded-assets';
import { GuardedWalletSummary } from './GuardedWalletSummary';

type GuardedState = GetWalletGuardedResponses[200]['data'];

/** An amount field's label names the payment asset; the burst field is a count. */
const MANDATE_FIELDS: Array<{ key: keyof GuardedAttachForm; label: string; isAmount: boolean }> = [
  { key: 'perTxCap', label: 'Per purchase', isAmount: true },
  { key: 'daily', label: 'Daily, equal to the on-chain limit', isAmount: true },
  { key: 'perSeller', label: 'Per seller per day', isAmount: true },
  { key: 'perAgent', label: 'Per agent per day', isAmount: true },
  { key: 'envelope', label: 'Lifetime', isAmount: true },
  { key: 'burstPerMinute', label: 'Purchases per minute', isAmount: false },
];

/**
 * Guarded smart wallet for a Purchasing hot wallet on a V2 source. The parent
 * owns the state through useGuardedWallet; this only renders and forwards.
 */
export function GuardedWalletSection({
  hotWalletId,
  agentVkh,
  network,
  state,
  isLoading,
  loadError,
  form,
  onFormChange,
  isSubmitting,
  onAttach,
  onDetach,
}: {
  hotWalletId: string;
  /** The hot wallet key, which is the smart wallet's agent. */
  agentVkh: string;
  network: 'Preprod' | 'Mainnet';
  state: GuardedState | null;
  isLoading: boolean;
  loadError: string | null;
  form: GuardedAttachForm;
  onFormChange: (form: GuardedAttachForm) => void;
  isSubmitting: boolean;
  onAttach: () => void;
  onDetach: () => void;
}) {
  const setField = (key: keyof GuardedAttachForm, value: string) =>
    onFormChange({ ...form, [key]: value });
  const guarded = state?.guardedWallet ?? null;
  const assetLabel = assetLabelOf(form.governedAsset, network);
  const isTokenWallet = form.governedAsset !== LOVELACE;

  return (
    <div className="flex flex-col gap-2">
      {isLoading ? (
        <Spinner size={16} />
      ) : loadError ? (
        <div className="text-sm text-destructive">{loadError}</div>
      ) : guarded ? (
        <GuardedWalletSummary
          hotWalletId={hotWalletId}
          agentVkh={agentVkh}
          network={network}
          guarded={guarded}
          chain={state?.chain ?? null}
          chainError={state?.chainError ?? null}
          isSubmitting={isSubmitting}
          onDetach={onDetach}
        />
      ) : (
        <div className="flex flex-col gap-2">
          <Input
            value={form.ownerAddress}
            onChange={(e) => setField('ownerAddress', e.target.value)}
            placeholder="Owner address"
          />
          <Textarea
            value={form.quorumKeys}
            onChange={(e) => setField('quorumKeys', e.target.value)}
            placeholder="Quorum key hashes, one per line"
            rows={3}
          />
          <div className="flex gap-2">
            <Input
              value={form.threshold}
              onChange={(e) => setField('threshold', e.target.value)}
              placeholder="Threshold"
              className="w-28"
            />
            <Input
              value={form.stateTokenName}
              onChange={(e) => setField('stateTokenName', e.target.value)}
              placeholder="State token name (hex)"
              className="flex-1"
            />
          </div>
          <Select
            value={form.governedAsset}
            onValueChange={(governedAsset) =>
              onFormChange({
                ...form,
                governedAsset,
                // Only a lovelace wallet may reuse an Exchain registration.
                mode: governedAsset === LOVELACE ? form.mode : 'register',
              })
            }
          >
            <SelectTrigger className="h-8" aria-label="Payment asset">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {governableAssets(network).map((asset) => (
                <SelectItem key={asset.assetId} value={asset.assetId}>
                  Agents pay in {asset.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <div className="flex gap-2">
            <Button
              size="sm"
              variant={form.mode === 'existing' ? 'default' : 'outline'}
              className="h-8"
              disabled={isTokenWallet}
              onClick={() => onFormChange({ ...form, mode: 'existing' })}
            >
              Already registered
            </Button>
            <Button
              size="sm"
              variant={form.mode === 'register' ? 'default' : 'outline'}
              className="h-8"
              onClick={() => onFormChange({ ...form, mode: 'register' })}
            >
              Register with Exchain
            </Button>
          </div>
          {form.mode === 'existing' ? (
            <Input
              value={form.exchainWalletId}
              onChange={(e) => setField('exchainWalletId', e.target.value)}
              placeholder="Exchain wallet id (wal_...)"
            />
          ) : (
            <div className="grid grid-cols-2 gap-2">
              {MANDATE_FIELDS.map(({ key, label, isAmount }) => {
                const fullLabel = isAmount ? `${label} (${assetLabel})` : label;
                return (
                  <Input
                    key={key}
                    value={form[key]}
                    onChange={(e) => setField(key, e.target.value)}
                    placeholder={fullLabel}
                    aria-label={fullLabel}
                  />
                );
              })}
              <div className="col-span-2 text-xs text-muted-foreground">
                Exchain cannot change a mandate once it is registered.
                {isTokenWallet &&
                  ' The wallet also needs an ADA limit: each token purchase carries about 1.5 ADA of min-UTxO.'}
              </div>
            </div>
          )}
          <Button size="sm" className="h-8 w-fit" onClick={onAttach} disabled={isSubmitting}>
            Guard this wallet
          </Button>
        </div>
      )}
    </div>
  );
}
