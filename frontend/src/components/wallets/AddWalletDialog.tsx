/* eslint-disable @typescript-eslint/no-explicit-any */
/* eslint-disable react-hooks/exhaustive-deps */

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
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { useState, useEffect } from 'react';
import {
  patchPaymentSourceExtended,
  postWallet,
  getUtxos,
  PaymentSourceExtended,
} from '@/lib/api/generated';
import { toast } from 'react-toastify';
import { useAppContext } from '@/lib/contexts/AppContext';

import { Spinner } from '@/components/ui/spinner';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { zodResolver } from '@hookform/resolvers/zod';
import { handleApiCall, validateCardanoAddress } from '@/lib/utils';
import { WalletTypeBadge } from '@/components/ui/wallet-type-badge';
import { usePaymentSourceExtendedAll } from '@/lib/hooks/usePaymentSourceExtendedAll';

interface AddWalletDialogProps {
  open: boolean;
  onClose: () => void;
  onSuccess?: () => void;
}

const walletSchema = z.object({
  mnemonic: z.string().min(1, 'Mnemonic phrase is required'),
  note: z.string().min(1, 'Note is required'),
  collectionAddress: z
    .string()
    .min(1, 'Collection address is required')
    .nullable()
    .optional(),
});

type WalletFormValues = z.infer<typeof walletSchema>;

export function AddWalletDialog({
  open,
  onClose,
  onSuccess,
}: AddWalletDialogProps) {
  const [type, setType] = useState<'Purchasing' | 'Selling'>('Purchasing');
  const [isLoading, setIsLoading] = useState(false);
  const [isGenerating, setIsGenerating] = useState(false);
  const [error, setError] = useState<string>('');
  const [paymentSourceId, setPaymentSourceId] = useState<string | null>(null);
  const { apiClient, network } = useAppContext();

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
  const [currentNetworkPaymentSources, setCurrentNetworkPaymentSources] =
    useState<PaymentSourceExtended[]>([]);
  useEffect(() => {
    setCurrentNetworkPaymentSources(
      paymentSources.filter((ps) => ps.network === network),
    );
  }, [paymentSources, network]);

  useEffect(() => {
    if (open) {
      setPaymentSourceId(currentNetworkPaymentSources[0]?.id || null);
    } else {
      reset();
      setError('');
    }
  }, [open]);

  const handleGenerateMnemonic = async () => {
    try {
      setIsGenerating(true);
      setError('');

      const response: any = await postWallet({
        client: apiClient,
        body: {
          network: network,
        },
      });

      if (response.error) {
        const error = response.error as { message: string };
        const errorMessage =
          error.message || 'Failed to generate mnemonic phrase';
        setError(errorMessage);
        toast.error(errorMessage);
        return;
      }

      if (response.data?.data?.walletMnemonic) {
        setValue('mnemonic', response.data.data.walletMnemonic);
      } else {
        throw new Error('Failed to generate mnemonic phrase');
      }
    } catch (error: any) {
      console.error('Error generating mnemonic:', error);
      const errorMessage =
        error?.response?.data?.error ||
        error?.message ||
        'Failed to generate mnemonic phrase';
      setError(errorMessage);
      toast.error(errorMessage);
    } finally {
      setIsGenerating(false);
    }
  };

  const onSubmit = async (data: WalletFormValues) => {
    setError('');

    let collectionAddress: string | null =
      data.collectionAddress?.trim() || null;

    // Validate collection address if provided
    if (collectionAddress) {
      const validation = validateCardanoAddress(collectionAddress, network);

      if (!validation.isValid) {
        setError('Invalid collection address: ' + validation.error);
        return;
      }

      const balance = await getUtxos({
        client: apiClient,
        query: {
          address: collectionAddress,
          network: network,
        },
      });
      if (balance.error || balance.data?.data?.Utxos?.length === 0) {
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

    await handleApiCall(
      () =>
        patchPaymentSourceExtended({
          client: apiClient,
          body: {
            id: paymentSourceId,
            [type === 'Purchasing'
              ? 'AddPurchasingWallets'
              : 'AddSellingWallets']: [
              {
                walletMnemonic: data.mnemonic.trim(),
                note: data.note.trim(),
                collectionAddress: collectionAddress,
              },
            ],
          },
        }),
      {
        onSuccess: () => {
          toast.success(`${type} wallet added successfully`);
          onSuccess?.();
          onClose();
        },
        onError: (error: any) => {
          setError(error.message || `Failed to add ${type} wallet`);
        },
        onFinally: () => {
          setIsLoading(false);
        },
        errorMessage: `Failed to add ${type} wallet`,
      },
    );
  };

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className="sm:max-w-[600px]">
        <DialogHeader>
          <DialogTitle>Add {type} Wallet</DialogTitle>
          <DialogDescription>
            Enter the wallet mnemonic phrase and required details to set up your{' '}
            {type.toLowerCase()} wallet.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
          {error && (
            <div className="text-sm text-destructive bg-destructive/10 p-3 rounded-md">
              {error}
            </div>
          )}

          <div className="space-y-2">
            <label className="text-sm font-medium">Wallet type</label>
            <div className="flex items-center gap-4 flex-nowrap">
              <Select
                value={type}
                onValueChange={(value: 'Purchasing' | 'Selling') =>
                  setType(value)
                }
              >
                <SelectTrigger className="flex-1">
                  <SelectValue placeholder="Select wallet type" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="Purchasing">Purchasing wallet</SelectItem>
                  <SelectItem value="Selling">Selling wallet</SelectItem>
                </SelectContent>
              </Select>
              <WalletTypeBadge type={type} className="shrink-0" />
            </div>
            <p className="text-sm text-muted-foreground">
              {type === 'Purchasing'
                ? 'A purchasing wallet is used to make payments for Agentic AI services. It will be used to send payments to sellers.'
                : 'A selling wallet is used to receive payments for Agentic AI services. It will be used to collect funds from buyers.'}
            </p>
          </div>

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
            <Textarea
              {...register('mnemonic')}
              placeholder="Enter your mnemonic phrase"
              required
              className="min-h-[100px] font-mono"
            />
            {errors.mnemonic && (
              <p className="text-xs text-destructive mt-1">
                {errors.mnemonic.message}
              </p>
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
              <p className="text-xs text-destructive mt-1">
                {errors.note.message}
              </p>
            )}
          </div>

          <div className="space-y-2">
            <label className="text-sm font-medium">
              {type === 'Purchasing' ? 'Refund' : 'Revenue'} Collection
              Address{' '}
            </label>
            <Input
              {...register('collectionAddress')}
              placeholder={`Enter the address where ${type === 'Purchasing' ? 'refunds' : 'revenue'} will be sent`}
            />
            {errors.collectionAddress && (
              <p className="text-xs text-destructive mt-1">
                {errors.collectionAddress.message}
              </p>
            )}
          </div>

          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={onClose}
              disabled={isLoading}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={isLoading}>
              {isLoading ? 'Adding...' : 'Add Wallet'}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
