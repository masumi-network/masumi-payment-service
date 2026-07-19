import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { Eye, EyeOff } from 'lucide-react';
import { useState, useEffect, useMemo } from 'react';
import { patchPaymentSourceExtended, postWallet } from '@/lib/api/generated';
import { fetchAllUtxos } from '@/lib/wallet-balance';
import { toast } from 'react-toastify';
import { useAppContext } from '@/lib/contexts/AppContext';

import { Spinner } from '@/components/ui/spinner';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { zodResolver } from '@hookform/resolvers/zod';
import { shortenAddress, validateCardanoAddress } from '@/lib/utils';
import { useApiMutation } from '@/lib/hooks/useApiMutation';
import type { PatchPaymentSourceExtendedData } from '@/lib/api/generated';
import { usePaymentSourceExtendedAll } from '@/lib/hooks/usePaymentSourceExtendedAll';
import { extractApiErrorMessage } from '@/lib/api-error';
import { extractApiPayload } from '@/lib/api-response';
import { PaymentSourceTypeBadge } from '@/components/payment-sources/PaymentSourceTypeBadge';
import { WalletTypeSelector } from '@/components/wallets/WalletTypeSelector';
import {
  FundWalletSetupForm,
  type FundWalletSetupSubmit,
} from '@/components/wallets/FundWalletSetupForm';
import { useFundWalletMutations } from '@/lib/hooks/useFundWalletMutations';
import { getWalletTypeLabel, type HotWalletType } from '@/lib/wallet-type';
import {
  getPaymentSourceTypeLabel,
  getPreferredPaymentSource,
  sortPaymentSourcesByPreference,
} from '@/lib/payment-source-type';

interface AddWalletDialogProps {
  open: boolean;
  onClose: () => void;
  onSuccess?: () => void;
  /** Preselect the wallet type, e.g. from the active Wallets tab. */
  defaultType?: HotWalletType;
}

const walletSchema = z.object({
  mnemonic: z.string().min(1, 'Mnemonic phrase is required'),
  note: z.string().min(1, 'Note is required'),
  collectionAddress: z.string().nullable().optional(),
});

type WalletFormValues = z.infer<typeof walletSchema>;

export function AddWalletDialog({ open, onClose, onSuccess, defaultType }: AddWalletDialogProps) {
  const [type, setType] = useState<HotWalletType>('Purchasing');
  // Covers the pre-submit collection-address check; the API call itself is
  // tracked by addWallet.isPending below.
  const [isPreparing, setIsPreparing] = useState(false);
  const [isGenerating, setIsGenerating] = useState(false);
  // Mnemonic textarea defaults to masked-by-CSS so a typed/pasted seed
  // phrase isn't visible to over-shoulder readers, screen-share, or
  // screenshots while the dialog is open. User explicitly reveals via
  // the eye toggle. `<textarea>` has no native `type="password"`, so we
  // apply `-webkit-text-security: disc` / `text-security: disc` via an
  // inline style when hidden.
  const [showMnemonic, setShowMnemonic] = useState(false);
  const [error, setError] = useState<string>('');
  const [paymentSourceId, setPaymentSourceId] = useState<string | null>(null);
  const { apiClient, network, selectedPaymentSourceId } = useAppContext();

  const {
    register,
    handleSubmit,
    setValue,
    reset,
    formState: { errors },
  } = useForm<WalletFormValues>({
    resolver: zodResolver(walletSchema),
    defaultValues: {
      mnemonic: '',
      note: '',
      collectionAddress: null,
    },
  });
  const { paymentSources } = usePaymentSourceExtendedAll();
  const currentNetworkPaymentSources = useMemo(
    () => paymentSources.filter((paymentSource) => paymentSource.network === network),
    [paymentSources, network],
  );
  const sortedPaymentSources = useMemo(
    () => sortPaymentSourcesByPreference(currentNetworkPaymentSources),
    [currentNetworkPaymentSources],
  );
  const defaultPaymentSource = useMemo(
    () =>
      sortedPaymentSources.find((paymentSource) => paymentSource.id === selectedPaymentSourceId) ??
      getPreferredPaymentSource(sortedPaymentSources),
    [selectedPaymentSourceId, sortedPaymentSources],
  );
  const selectedPaymentSource = useMemo(
    () =>
      sortedPaymentSources.find((paymentSource) => paymentSource.id === paymentSourceId) ?? null,
    [paymentSourceId, sortedPaymentSources],
  );

  useEffect(() => {
    if (open) {
      setPaymentSourceId(defaultPaymentSource?.id ?? null);
      // Preselect the type from the active tab; fall back to Purchasing on the
      // All tab, matching the previous default.
      setType(defaultType ?? 'Purchasing');
    } else {
      reset();
      setError('');
      setIsPreparing(false);
      setPaymentSourceId(null);
    }
  }, [defaultPaymentSource?.id, open, reset, defaultType]);

  const handleGenerateMnemonic = async () => {
    try {
      setIsGenerating(true);
      setError('');

      const response = await postWallet({
        client: apiClient,
        body: {
          network: network,
        },
      });

      if (response.error) {
        const errorMessage = extractApiErrorMessage(
          response.error,
          'Failed to generate mnemonic phrase',
        );
        setError(errorMessage);
        toast.error(errorMessage);
        return;
      }

      const walletMnemonic = extractApiPayload<{ walletMnemonic?: string }>(
        response,
      )?.walletMnemonic;
      if (walletMnemonic) {
        setValue('mnemonic', walletMnemonic);
      } else {
        throw new Error('Failed to generate mnemonic phrase');
      }
    } catch (error: unknown) {
      console.error('Error generating mnemonic:', error);
      const errorMessage = extractApiErrorMessage(error, 'Failed to generate mnemonic phrase');
      setError(errorMessage);
      toast.error(errorMessage);
    } finally {
      setIsGenerating(false);
    }
  };

  const addWallet = useApiMutation({
    mutationFn: (body: NonNullable<PatchPaymentSourceExtendedData['body']>) =>
      patchPaymentSourceExtended({ client: apiClient, body }),
    errorMessage: `Failed to add ${type} wallet`,
    toastOnError: false,
  });
  const { createFundWallet } = useFundWalletMutations(paymentSourceId);
  const isLoading = isPreparing || addWallet.isPending || createFundWallet.isPending;

  const onSubmit = async (data: WalletFormValues) => {
    setError('');
    setIsPreparing(true);

    let collectionAddress: string | null = data.collectionAddress?.trim() || null;

    try {
      // Validate collection address if provided
      if (collectionAddress) {
        const validation = validateCardanoAddress(collectionAddress, network);

        if (!validation.isValid) {
          setError('Invalid collection address: ' + validation.error);
          return;
        }

        let isAddressUnused = false;
        try {
          const utxos = await fetchAllUtxos(apiClient, network, collectionAddress);
          isAddressUnused = utxos.length === 0;
        } catch {
          isAddressUnused = true;
        }
        if (isAddressUnused) {
          toast.warning(
            'Collection address has not been used yet, please check if this is the correct address',
          );
        }
      } else {
        collectionAddress = null;
      }

      if (!paymentSourceId) {
        setError('No payment source available');
        return;
      }

      const response = await addWallet
        .mutateAsync({
          id: paymentSourceId,
          [type === 'Purchasing' ? 'AddPurchasingWallets' : 'AddSellingWallets']: [
            {
              walletMnemonic: data.mnemonic.trim(),
              note: data.note.trim(),
              collectionAddress: collectionAddress,
            },
          ],
        })
        .catch((error: Error) => {
          setError(error.message);
          return null;
        });
      if (!response) return;

      toast.success(`${type} wallet added successfully`);
      onSuccess?.();
      onClose();
    } finally {
      setIsPreparing(false);
    }
  };

  const handleCreateFundWallet = async (values: FundWalletSetupSubmit) => {
    setError('');
    if (!paymentSourceId) {
      setError('No payment source available');
      return;
    }

    try {
      await createFundWallet.mutateAsync({
        ...values,
        paymentSourceId,
      });
      toast.success('Funding wallet added. Send funds to its address to enable top-ups.');
      onSuccess?.();
      onClose();
    } catch {
      /* surfaced by useApiMutation */
    }
  };

  const walletTypeLabel = getWalletTypeLabel(type).toLowerCase();

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent size="lg">
        <DialogHeader>
          <DialogTitle>Add wallet</DialogTitle>
          <DialogDescription>
            Create a {walletTypeLabel} wallet for {network}. The required setup changes with the
            wallet&apos;s role.
          </DialogDescription>
        </DialogHeader>

        <WalletTypeSelector value={type} onChange={setType} disabled={isLoading} />

        <div className="space-y-2">
          <label className="text-sm font-medium">Payment source</label>
          <Select
            value={paymentSourceId ?? ''}
            onValueChange={setPaymentSourceId}
            disabled={isLoading || sortedPaymentSources.length === 0}
          >
            <SelectTrigger>
              <SelectValue placeholder="Select payment source" />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {sortedPaymentSources.map((paymentSource) => (
                  <SelectItem key={paymentSource.id} value={paymentSource.id}>
                    <div className="flex min-w-0 items-center gap-2">
                      <PaymentSourceTypeBadge
                        paymentSourceType={paymentSource.paymentSourceType}
                        showDefault
                      />
                      <span className="truncate">
                        {shortenAddress(paymentSource.smartContractAddress, 8)}
                      </span>
                    </div>
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">
            {selectedPaymentSource
              ? `This wallet belongs to ${getPaymentSourceTypeLabel(selectedPaymentSource.paymentSourceType)} on ${network}.`
              : 'Create a payment source before adding wallets.'}
          </p>
        </div>

        {error && (
          <div className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">{error}</div>
        )}

        {type === 'Funding' ? (
          <FundWalletSetupForm
            onSubmit={handleCreateFundWallet}
            isSubmitting={createFundWallet.isPending}
            network={network}
            onCancel={onClose}
            showDescription={false}
            submitLabel="Add funding wallet"
          />
        ) : (
          <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <label className="text-sm font-medium">
                  Mnemonic Phrase <span className="text-destructive">*</span>
                </label>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={handleGenerateMnemonic}
                  disabled={isGenerating}
                  className="h-8"
                >
                  {isGenerating ? <Spinner size={16} /> : 'Generate'}
                </Button>
              </div>
              <div className="relative">
                <Textarea
                  {...register('mnemonic')}
                  placeholder="Enter your mnemonic phrase"
                  required
                  className="min-h-[100px] font-mono pr-10"
                  spellCheck={false}
                  autoComplete="off"
                  style={
                    showMnemonic
                      ? undefined
                      : ({
                          WebkitTextSecurity: 'disc',
                          textSecurity: 'disc',
                        } as React.CSSProperties)
                  }
                />
                <button
                  type="button"
                  onClick={() => setShowMnemonic((v) => !v)}
                  className="absolute right-2 top-2 text-muted-foreground hover:text-foreground"
                  aria-label={showMnemonic ? 'Hide mnemonic' : 'Show mnemonic'}
                  tabIndex={-1}
                >
                  {showMnemonic ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
              {errors.mnemonic && (
                <p className="text-xs text-destructive mt-1">{errors.mnemonic.message}</p>
              )}
            </div>

            <div className="space-y-2">
              <label className="text-sm font-medium">
                Note <span className="text-destructive">*</span>
              </label>
              <Input
                {...register('note')}
                placeholder="Enter a note to identify this wallet"
                required
              />
              {errors.note && (
                <p className="text-xs text-destructive mt-1">{errors.note.message}</p>
              )}
            </div>

            <div className="space-y-2">
              <label className="text-sm font-medium">
                {type === 'Purchasing' ? 'Refund' : 'Revenue'} Collection Address{' '}
              </label>
              <Input
                {...register('collectionAddress')}
                placeholder={`Enter the address where ${type === 'Purchasing' ? 'refunds' : 'revenue'} will be sent`}
              />
              {errors.collectionAddress && (
                <p className="text-xs text-destructive mt-1">{errors.collectionAddress.message}</p>
              )}
            </div>

            <div className="flex justify-end gap-2">
              <Button type="button" variant="outline" onClick={onClose} disabled={isLoading}>
                Cancel
              </Button>
              <Button type="submit" disabled={isLoading}>
                {isLoading ? 'Adding...' : 'Add Wallet'}
              </Button>
            </div>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
