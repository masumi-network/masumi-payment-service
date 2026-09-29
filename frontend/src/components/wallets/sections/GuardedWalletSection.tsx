import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Spinner } from '@/components/ui/spinner';
import { WalletLink } from '@/components/ui/wallet-link';
import { formatLovelaceAsAda } from '@/lib/format-lovelace-display';
import type { GetWalletGuardedResponses } from '@/lib/api/generated';
import type { GuardedAttachForm } from '@/components/wallets/useGuardedWallet';

type GuardedState = GetWalletGuardedResponses[200]['data'];

const MANDATE_FIELDS: Array<{ key: keyof GuardedAttachForm; label: string }> = [
  { key: 'perTxCapAda', label: 'Per purchase (ADA)' },
  { key: 'dailyAda', label: 'Daily, equal to the on-chain limit (ADA)' },
  { key: 'perSellerAda', label: 'Per seller per day (ADA)' },
  { key: 'perAgentAda', label: 'Per agent per day (ADA)' },
  { key: 'envelopeAda', label: 'Lifetime (ADA)' },
  { key: 'burstPerMinute', label: 'Purchases per minute' },
];

/**
 * Guarded smart wallet for a Purchasing hot wallet on a V2 source. The parent
 * owns the state through useGuardedWallet; this only renders and forwards.
 */
export function GuardedWalletSection({
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

  return (
    <div className="flex flex-col gap-2 mt-2 border-t pt-4">
      <div className="text-xs text-muted-foreground">Guarded smart wallet (Exchain co-sign)</div>
      {isLoading ? (
        <Spinner size={16} />
      ) : loadError ? (
        <div className="text-sm text-destructive">{loadError}</div>
      ) : guarded ? (
        <div className="flex flex-col gap-1 text-sm">
          <div className="flex items-center gap-2">
            <span className="text-muted-foreground">Script</span>
            <WalletLink address={guarded.scriptAddress} network={network} shorten={15} />
          </div>
          {state?.chain ? (
            <>
              <div>Balance: {formatLovelaceAsAda(state.chain.lovelace)}</div>
              <div>
                Spent this period: {formatLovelaceAsAda(state.chain.spentInPeriodLovelace)} of{' '}
                {formatLovelaceAsAda(state.chain.periodLimitLovelace)}
              </div>
            </>
          ) : (
            <div className="text-destructive">Chain read failed: {state?.chainError}</div>
          )}
          <div>
            Quorum: {guarded.threshold} of {guarded.quorumVkhs.length}
          </div>
          <div className="font-mono text-xs">
            Exchain wallet: {guarded.exchainWalletId ?? 'not registered'}
          </div>
          <Button
            variant="outline"
            size="sm"
            className="h-8 w-fit"
            onClick={onDetach}
            disabled={isSubmitting}
          >
            Remove guard
          </Button>
        </div>
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
          <div className="flex gap-2">
            <Button
              size="sm"
              variant={form.mode === 'existing' ? 'default' : 'outline'}
              className="h-8"
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
              {MANDATE_FIELDS.map(({ key, label }) => (
                <Input
                  key={key}
                  value={form[key]}
                  onChange={(e) => setField(key, e.target.value)}
                  placeholder={label}
                  aria-label={label}
                />
              ))}
              <div className="col-span-2 text-xs text-muted-foreground">
                Exchain cannot change a mandate once it is registered.
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
