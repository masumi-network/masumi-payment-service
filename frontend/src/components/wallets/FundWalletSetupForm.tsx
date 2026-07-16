import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { zodResolver } from '@hookform/resolvers/zod';
import { Eye, EyeOff } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Spinner } from '@/components/ui/spinner';
import { convertDecimalToBaseUnits } from '@/lib/convertDecimalToBaseUnits';

const adaAmount = (label: string) =>
  z
    .string()
    .min(1, `${label} is required`)
    .refine((value) => /^\d+(\.\d{1,6})?$/.test(value) && Number(value) > 0, {
      message: `${label} must be a positive ADA amount (max 6 decimals)`,
    });

const setupSchema = z
  .object({
    mnemonic: z.string().min(1, 'Mnemonic phrase is required'),
    warningThreshold: adaAmount('Warning threshold'),
    criticalThreshold: adaAmount('Critical threshold'),
    topupAmount: adaAmount('Top-up amount'),
    note: z.string().max(250).optional(),
  })
  // Mirrors the server rule. Checked here too so the operator sees it against
  // the offending field instead of as a 400 toast after submitting a mnemonic.
  .refine((values) => Number(values.criticalThreshold) < Number(values.warningThreshold), {
    message: 'Critical threshold must be below the warning threshold',
    path: ['criticalThreshold'],
  });

export type FundWalletSetupValues = z.infer<typeof setupSchema>;

export type FundWalletSetupSubmit = {
  walletMnemonic: string;
  warningThreshold: string;
  criticalThreshold: string;
  topupAmount: string;
  note?: string;
};

export function FundWalletSetupForm({
  onSubmit,
  isSubmitting,
}: {
  onSubmit: (values: FundWalletSetupSubmit) => Promise<void>;
  isSubmitting: boolean;
}) {
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
    defaultValues: {
      mnemonic: '',
      warningThreshold: '50',
      criticalThreshold: '20',
      topupAmount: '100',
      note: '',
    },
  });

  const submit = handleSubmit(async (values) => {
    await onSubmit({
      walletMnemonic: values.mnemonic.trim(),
      // The API takes lovelace; the form takes ADA because that's what
      // operators think in.
      warningThreshold: convertDecimalToBaseUnits(values.warningThreshold),
      criticalThreshold: convertDecimalToBaseUnits(values.criticalThreshold),
      topupAmount: convertDecimalToBaseUnits(values.topupAmount),
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
          style={
            showMnemonic
              ? undefined
              : ({ WebkitTextSecurity: 'disc', textSecurity: 'disc' } as React.CSSProperties)
          }
          {...register('mnemonic')}
        />
        {errors.mnemonic && <p className="text-xs text-destructive">{errors.mnemonic.message}</p>}
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-2">
          <label className="text-sm font-medium" htmlFor="fund-wallet-warning">
            Warning threshold (ADA)
          </label>
          <Input id="fund-wallet-warning" {...register('warningThreshold')} />
          <p className="text-xs text-muted-foreground">Below this, top-ups are batched.</p>
          {errors.warningThreshold && (
            <p className="text-xs text-destructive">{errors.warningThreshold.message}</p>
          )}
        </div>
        <div className="space-y-2">
          <label className="text-sm font-medium" htmlFor="fund-wallet-critical">
            Critical threshold (ADA)
          </label>
          <Input id="fund-wallet-critical" {...register('criticalThreshold')} />
          <p className="text-xs text-muted-foreground">Below this, top-ups are sent immediately.</p>
          {errors.criticalThreshold && (
            <p className="text-xs text-destructive">{errors.criticalThreshold.message}</p>
          )}
        </div>
      </div>

      <div className="space-y-2">
        <label className="text-sm font-medium" htmlFor="fund-wallet-topup">
          Top-up amount (ADA)
        </label>
        <Input id="fund-wallet-topup" {...register('topupAmount')} />
        <p className="text-xs text-muted-foreground">
          Sent to each wallet that falls below a threshold.
        </p>
        {errors.topupAmount && (
          <p className="text-xs text-destructive">{errors.topupAmount.message}</p>
        )}
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
