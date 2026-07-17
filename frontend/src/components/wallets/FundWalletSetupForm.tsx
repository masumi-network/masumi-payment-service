import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { zodResolver } from '@hookform/resolvers/zod';
import { Eye, EyeOff } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Spinner } from '@/components/ui/spinner';
import {
  FundWalletAssetRows,
  makeAssetRow,
  type AssetRow,
} from '@/components/wallets/FundWalletAssetRows';
import { buildAssetPolicyPayload, type AssetPolicyPayload } from '@/lib/fund-wallet-assets';

const setupSchema = z.object({
  mnemonic: z.string().min(1, 'Mnemonic phrase is required'),
  note: z.string().max(250).optional(),
});

export type FundWalletSetupValues = z.infer<typeof setupSchema>;

export type FundWalletSetupSubmit = {
  walletMnemonic: string;
  Assets: AssetPolicyPayload[];
  note?: string;
};

export function FundWalletSetupForm({
  onSubmit,
  isSubmitting,
  network,
}: {
  onSubmit: (values: FundWalletSetupSubmit) => Promise<void>;
  isSubmitting: boolean;
  network: 'Preprod' | 'Mainnet';
}) {
  // Thresholds are per asset, so they live outside react-hook-form: the row
  // count is dynamic and each row's valid range depends on its asset.
  const [assetRows, setAssetRows] = useState<AssetRow[]>([
    {
      ...makeAssetRow('lovelace'),
      warningThreshold: '50',
      criticalThreshold: '20',
      topupAmount: '100',
    },
  ]);
  const [assetError, setAssetError] = useState<string | null>(null);
  // The mnemonic is masked by default so a pasted seed phrase isn't exposed to
  // over-shoulder readers, screen shares or screenshots. `<textarea>` has no
  // native password type, hence the inline text-security style.
  const [showMnemonic, setShowMnemonic] = useState(false);

  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<FundWalletSetupValues>({
    resolver: zodResolver(setupSchema),
    defaultValues: { mnemonic: '', note: '' },
  });

  const submit = handleSubmit(async (values) => {
    // Amounts are entered in display units (ADA, USDM) and converted to each
    // asset's smallest unit here — operators think in ADA, the API stores
    // lovelace.
    const policy = buildAssetPolicyPayload(assetRows, network);
    if ('error' in policy) {
      setAssetError(policy.error);
      return;
    }
    setAssetError(null);

    await onSubmit({
      walletMnemonic: values.mnemonic.trim(),
      Assets: policy.assets,
      note: values.note?.trim() || undefined,
    });
  });

  return (
    <form onSubmit={submit} className="space-y-4">
      <div className="rounded-md bg-muted/50 p-3 text-xs text-muted-foreground">
        The fund wallet tops up the buying and selling wallets of this payment source when they run
        low. Provide the mnemonic of a wallet you already control — it is stored encrypted, and the
        address is shown afterwards so you can fund it.
      </div>

      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <label className="text-sm font-medium" htmlFor="fund-wallet-mnemonic">
            Mnemonic phrase
          </label>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-6 px-2"
            onClick={() => setShowMnemonic((visible) => !visible)}
            aria-label={showMnemonic ? 'Hide mnemonic' : 'Show mnemonic'}
          >
            {showMnemonic ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
          </Button>
        </div>
        <Textarea
          id="fund-wallet-mnemonic"
          rows={3}
          placeholder="word1 word2 word3 ... word24"
          // The visual masking below does not stop browser text services from
          // READING the field: enhanced spellcheck ships field contents to
          // third-party servers ("spell-jacking"), and autocomplete would offer
          // to store the phrase. This is a treasury seed — opt out of all of it.
          spellCheck={false}
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="none"
          style={
            showMnemonic
              ? undefined
              : ({ WebkitTextSecurity: 'disc', textSecurity: 'disc' } as React.CSSProperties)
          }
          {...register('mnemonic')}
        />
        {errors.mnemonic && <p className="text-xs text-destructive">{errors.mnemonic.message}</p>}
      </div>

      <div className="space-y-2">
        <label className="text-sm font-medium">Assets to distribute</label>
        <p className="text-xs text-muted-foreground">
          One entry per asset this wallet should top up. Low-balance rules are per asset, so a
          wallet can run low on USDM while its ADA is healthy — each asset needs its own thresholds.
        </p>
        <FundWalletAssetRows
          rows={assetRows}
          onChange={setAssetRows}
          network={network}
          disabled={isSubmitting}
        />
        {assetError && <p className="text-xs text-destructive">{assetError}</p>}
      </div>

      <div className="space-y-2">
        <label className="text-sm font-medium" htmlFor="fund-wallet-note">
          Note (optional)
        </label>
        <Input id="fund-wallet-note" placeholder="e.g. Preprod treasury" {...register('note')} />
      </div>

      <Button type="submit" disabled={isSubmitting} className="w-full">
        {isSubmitting ? <Spinner size={16} /> : 'Create fund wallet'}
      </Button>
    </form>
  );
}
