import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { zodResolver } from '@hookform/resolvers/zod';
import { Eye, EyeOff, Landmark, Wand2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Spinner } from '@/components/ui/spinner';
import { useAppContext } from '@/lib/contexts/AppContext';
import { postWallet } from '@/lib/api/generated';
import { extractApiErrorMessage } from '@/lib/api-error';
import { extractApiPayload } from '@/lib/api-response';
import { toast } from 'react-toastify';

const setupSchema = z.object({
  mnemonic: z.string().min(1, 'Mnemonic phrase is required'),
  note: z.string().max(250).optional(),
});

export type FundWalletSetupValues = z.infer<typeof setupSchema>;

export type FundWalletSetupSubmit = {
  walletMnemonic: string;
  note?: string;
};

export function FundWalletSetupForm({
  onSubmit,
  isSubmitting,
  network,
  onCancel,
  showDescription = true,
  submitLabel = 'Create fund wallet',
}: {
  onSubmit: (values: FundWalletSetupSubmit) => Promise<void>;
  isSubmitting: boolean;
  network: 'Preprod' | 'Mainnet';
  onCancel?: () => void;
  showDescription?: boolean;
  submitLabel?: string;
}) {
  // The mnemonic is masked by default so a pasted seed phrase isn't exposed to
  // over-shoulder readers, screen shares or screenshots. `<textarea>` has no
  // native password type, hence the inline text-security style.
  const [showMnemonic, setShowMnemonic] = useState(false);
  const [isGenerating, setIsGenerating] = useState(false);
  // Set once the operator generates a fresh phrase here, so we can warn them to
  // back it up — a pasted phrase they already control needs no such warning.
  const [justGenerated, setJustGenerated] = useState(false);

  const { apiClient } = useAppContext();

  const {
    register,
    handleSubmit,
    setValue,
    formState: { errors },
  } = useForm<FundWalletSetupValues>({
    resolver: zodResolver(setupSchema),
    defaultValues: { mnemonic: '', note: '' },
  });

  // Brew a fresh 24-word wallet server-side (postWallet returns a mnemonic
  // without persisting anything) and drop it into the field, revealed so the
  // operator can record it before creating the fund wallet.
  const handleGenerateMnemonic = async () => {
    try {
      setIsGenerating(true);
      const response = await postWallet({ client: apiClient, body: { network } });
      if (response.error) {
        toast.error(extractApiErrorMessage(response.error, 'Failed to generate a wallet'));
        return;
      }
      const walletMnemonic = extractApiPayload<{ walletMnemonic?: string }>(
        response,
      )?.walletMnemonic;
      if (!walletMnemonic) throw new Error('Failed to generate a wallet');
      setValue('mnemonic', walletMnemonic, { shouldValidate: true });
      setShowMnemonic(true);
      setJustGenerated(true);
    } catch (error) {
      toast.error(extractApiErrorMessage(error, 'Failed to generate a wallet'));
    } finally {
      setIsGenerating(false);
    }
  };

  const submit = handleSubmit(async (values) => {
    await onSubmit({
      walletMnemonic: values.mnemonic.trim(),
      note: values.note?.trim() || undefined,
    });
  });

  return (
    <form onSubmit={submit} className="space-y-4">
      {showDescription && (
        <div className="flex gap-3 rounded-lg border bg-muted/30 p-3">
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-secondary text-secondary-foreground">
            <Landmark className="h-4 w-4" />
          </span>
          <p className="text-xs leading-relaxed text-muted-foreground">
            This wallet supplies top-ups to buying and selling wallets on the same payment source.
            Its seed is encrypted, and you configure each target&apos;s threshold and amount in its
            low-balance rules.
          </p>
        </div>
      )}

      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <label className="text-sm font-medium" htmlFor="fund-wallet-mnemonic">
            Mnemonic phrase
          </label>
          <div className="flex items-center gap-1">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-6 gap-1 px-2 text-xs"
              onClick={handleGenerateMnemonic}
              disabled={isGenerating || isSubmitting}
            >
              {isGenerating ? (
                <Spinner size={12} />
              ) : (
                <>
                  <Wand2 className="h-3.5 w-3.5" /> Generate
                </>
              )}
            </Button>
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
        </div>
        <Textarea
          id="fund-wallet-mnemonic"
          rows={3}
          placeholder="word1 word2 word3 ... word24"
          // The visual masking below does not stop browser text services from
          // READING the field: enhanced spellcheck ships field contents to
          // third-party servers ("spell-jacking"), and autocomplete would offer
          // to store the phrase. This is a treasury seed: opt out of all of it.
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
        {justGenerated && (
          <p className="text-xs text-amber-600 dark:text-amber-500">
            New wallet generated. Back up this phrase somewhere safe before creating the fund
            wallet. It controls the treasury balance and cannot be recovered.
          </p>
        )}
        {errors.mnemonic && <p className="text-xs text-destructive">{errors.mnemonic.message}</p>}
      </div>

      <div className="space-y-2">
        <label className="text-sm font-medium" htmlFor="fund-wallet-note">
          Note (optional)
        </label>
        <Input id="fund-wallet-note" placeholder="e.g. Preprod treasury" {...register('note')} />
      </div>

      <div className="flex justify-end gap-2">
        {onCancel && (
          <Button type="button" variant="outline" onClick={onCancel} disabled={isSubmitting}>
            Cancel
          </Button>
        )}
        <Button type="submit" disabled={isSubmitting} className={onCancel ? undefined : 'w-full'}>
          {isSubmitting ? <Spinner size={16} /> : submitLabel}
        </Button>
      </div>
    </form>
  );
}
