import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useState, useEffect, useCallback, useMemo } from 'react';
import { useForm, Controller } from 'react-hook-form';
import { z } from 'zod';
import { zodResolver } from '@hookform/resolvers/zod';
import { toast } from 'react-toastify';
import { PaymentSourceExtended, postInboxAgents, SellingWallet } from '@/lib/api/generated';
import { useAppContext } from '@/lib/contexts/AppContext';
import { shortenAddress } from '@/lib/utils';
import { useWallets } from '@/lib/queries/useWallets';
import { usePaymentSourceExtendedAll } from '@/lib/hooks/usePaymentSourceExtendedAll';
import {
  INBOX_REGISTRY_LIMITS,
  REGISTRY_DECIMAL_ADA_AMOUNT_PATTERN,
  isReservedInboxSlug,
  normalizeInboxSlug,
} from '@/lib/registry-validation';

interface RegisterInboxAgentDialogProps {
  open: boolean;
  onClose: () => void;
  onSuccess: () => void;
}

function convertDecimalToBaseUnits(value: string, decimals = 6): string {
  const [wholePart, fractionalPart = ''] = value.split('.');
  const normalizedFractionalPart = fractionalPart.padEnd(decimals, '0').slice(0, decimals);
  const scale = BigInt(10 ** decimals);

  return (BigInt(wholePart || '0') * scale + BigInt(normalizedFractionalPart || '0')).toString();
}

const inboxAgentSchema = z.object({
  name: z
    .string()
    .min(1, 'Name is required')
    .max(INBOX_REGISTRY_LIMITS.agentName, 'Name must be less than 120 characters'),
  description: z
    .string()
    .max(INBOX_REGISTRY_LIMITS.description, 'Description must be less than 500 characters')
    .optional()
    .or(z.literal('')),
  agentSlug: z
    .string()
    .min(1, 'Inbox slug is required')
    .max(INBOX_REGISTRY_LIMITS.agentSlug, 'Inbox slug must be less than 80 characters')
    .refine((value) => value.trim() === value, {
      message: 'Inbox slug must not contain leading or trailing whitespace',
    })
    .refine((value) => normalizeInboxSlug(value) === value, {
      message: 'Inbox slug must already be canonical',
    })
    .refine((value) => !isReservedInboxSlug(value), {
      message: 'Inbox slug is reserved',
    }),
  selectedWallet: z
    .string()
    .min(1, 'Wallet is required')
    .max(INBOX_REGISTRY_LIMITS.walletReference, 'Wallet is invalid'),
  recipientWalletAddress: z
    .string()
    .max(INBOX_REGISTRY_LIMITS.walletReference, 'Recipient wallet must be less than 250 characters')
    .optional()
    .or(z.literal('')),
  sendFundingAda: z
    .string()
    .optional()
    .or(z.literal(''))
    .refine(
      (value) => value == null || value === '' || REGISTRY_DECIMAL_ADA_AMOUNT_PATTERN.test(value),
      'Funding amount must be a valid ADA amount with up to 6 decimals',
    ),
});

type InboxAgentFormValues = z.infer<typeof inboxAgentSchema>;

export function RegisterInboxAgentDialog({
  open,
  onClose,
  onSuccess,
}: RegisterInboxAgentDialogProps) {
  const [isLoading, setIsLoading] = useState(false);
  const [sellingWallets, setSellingWallets] = useState<
    { wallet: SellingWallet; balance: number }[]
  >([]);
  const { wallets, isLoading: isLoadingWallets } = useWallets();
  const { apiClient, network } = useAppContext();
  const { paymentSources } = usePaymentSourceExtendedAll();
  const [currentNetworkPaymentSources, setCurrentNetworkPaymentSources] = useState<
    PaymentSourceExtended[]
  >([]);

  const {
    register,
    handleSubmit,
    control,
    setValue,
    reset,
    watch,
    formState: { errors },
  } = useForm<InboxAgentFormValues>({
    resolver: zodResolver(inboxAgentSchema),
    defaultValues: {
      name: '',
      description: '',
      agentSlug: '',
      selectedWallet: '',
      recipientWalletAddress: '',
      sendFundingAda: '',
    },
  });

  const selectedWalletVkey = watch('selectedWallet');
  const selectedRecipientWalletAddress = watch('recipientWalletAddress');
  const selectedSendFundingAda = watch('sendFundingAda');

  useEffect(() => {
    setCurrentNetworkPaymentSources(
      paymentSources.filter((paymentSource) => paymentSource.network === network),
    );
  }, [paymentSources, network]);

  useEffect(() => {
    setSellingWallets(
      wallets
        .filter((wallet) => wallet.type === 'Selling')
        .map((wallet) => ({
          wallet: {
            id: wallet.id,
            walletVkey: wallet.walletVkey,
            walletAddress: wallet.walletAddress,
            collectionAddress: wallet.collectionAddress,
            note: wallet.note,
            LowBalanceSummary: wallet.LowBalanceSummary,
          },
          balance: parseInt(wallet.balance, 10),
        })),
    );
  }, [wallets]);

  useEffect(() => {
    if (open) {
      reset();
    }
  }, [open, reset]);

  const selectedWallet = useMemo(
    () => sellingWallets.find((wallet) => wallet.wallet.walletVkey === selectedWalletVkey),
    [sellingWallets, selectedWalletVkey],
  );

  const selectedPaymentSource = useMemo(
    () =>
      currentNetworkPaymentSources.find((paymentSource) =>
        paymentSource.SellingWallets?.some((wallet) => wallet.walletVkey === selectedWalletVkey),
      ),
    [currentNetworkPaymentSources, selectedWalletVkey],
  );

  const recipientWalletOptions = useMemo(
    () =>
      selectedPaymentSource
        ? [
            ...(selectedPaymentSource.SellingWallets ?? []),
            ...(selectedPaymentSource.PurchasingWallets ?? []),
          ].filter((wallet) => wallet.walletAddress !== selectedWallet?.wallet.walletAddress)
        : [],
    [selectedPaymentSource, selectedWallet?.wallet.walletAddress],
  );

  useEffect(() => {
    if (!selectedRecipientWalletAddress) {
      if (selectedSendFundingAda) {
        setValue('sendFundingAda', '');
      }
      return;
    }

    const isRecipientStillAvailable = recipientWalletOptions.some(
      (wallet) => wallet.walletAddress === selectedRecipientWalletAddress,
    );
    if (!isRecipientStillAvailable) {
      setValue('recipientWalletAddress', '');
    }
  }, [recipientWalletOptions, selectedRecipientWalletAddress, selectedSendFundingAda, setValue]);

  const onSubmit = useCallback(
    async (data: InboxAgentFormValues) => {
      try {
        setIsLoading(true);

        const selectedWalletBalance = sellingWallets.find(
          (wallet) => wallet.wallet.walletVkey === data.selectedWallet,
        )?.balance;
        if (selectedWalletBalance == null || selectedWalletBalance <= 3000000) {
          toast.error('Insufficient balance in selected wallet');
          return;
        }

        const response = await postInboxAgents({
          client: apiClient,
          body: {
            network,
            sellingWalletVkey: data.selectedWallet,
            recipientWalletAddress: data.recipientWalletAddress || undefined,
            sendFundingLovelace:
              data.recipientWalletAddress && data.sendFundingAda
                ? convertDecimalToBaseUnits(data.sendFundingAda)
                : undefined,
            name: data.name,
            description: data.description || undefined,
            agentSlug: data.agentSlug,
          },
        });

        if (!response.data?.data?.id) {
          throw new Error('Failed to register inbox agent: Invalid response from server');
        }

        toast.success('Inbox agent registered successfully');
        onSuccess();
        onClose();
        reset();
      } catch (error: any) {
        console.error('Error registering inbox agent:', error);
        toast.error(error?.message ?? 'Failed to register inbox agent');
      } finally {
        setIsLoading(false);
      }
    },
    [apiClient, network, onClose, onSuccess, reset, sellingWallets],
  );

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className="sm:max-w-[640px] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Register Inbox Agent</DialogTitle>
          <p className="text-sm text-muted-foreground mt-2">
            Register an inbox agent NFT with optional managed holding wallet delivery.
          </p>
        </DialogHeader>
        <form onSubmit={handleSubmit(onSubmit)} className="space-y-6">
          <div className="space-y-2">
            <label className="text-sm font-medium">
              Name <span className="text-red-500">*</span>
            </label>
            <Input
              {...register('name')}
              maxLength={INBOX_REGISTRY_LIMITS.agentName}
              placeholder="Enter a name for your inbox agent"
              className={errors.name ? 'border-red-500' : ''}
            />
            {errors.name && <p className="text-sm text-red-500">{errors.name.message}</p>}
          </div>

          <div className="space-y-2">
            <label className="text-sm font-medium">Description</label>
            <div className="relative">
              <Textarea
                {...register('description')}
                rows={4}
                maxLength={INBOX_REGISTRY_LIMITS.description}
                placeholder="Describe what this inbox agent is used for"
                className={`resize-none overflow-y-auto h-[112px] ${errors.description ? 'border-red-500' : ''}`}
              />
              <div className="absolute bottom-2 right-2 text-xs text-muted-foreground">
                {watch('description')?.length || 0}/{INBOX_REGISTRY_LIMITS.description}
              </div>
            </div>
            {errors.description && (
              <p className="text-sm text-red-500">{errors.description.message}</p>
            )}
          </div>

          <div className="space-y-2">
            <label className="text-sm font-medium">
              Inbox slug <span className="text-red-500">*</span>
            </label>
            <Input
              {...register('agentSlug', {
                onBlur: (event) => {
                  setValue('agentSlug', normalizeInboxSlug(event.target.value), {
                    shouldValidate: true,
                    shouldDirty: true,
                  });
                },
              })}
              maxLength={INBOX_REGISTRY_LIMITS.agentSlug}
              placeholder="support-inbox"
              className={errors.agentSlug ? 'border-red-500' : ''}
            />
            <p className="text-xs text-muted-foreground">
              Use lowercase letters, numbers, and hyphens. The value must already be canonical.
            </p>
            {errors.agentSlug && <p className="text-sm text-red-500">{errors.agentSlug.message}</p>}
          </div>

          <div className="space-y-2">
            <label className="text-sm font-medium">
              Minting wallet <span className="text-red-500">*</span>
            </label>
            <Controller
              control={control}
              name="selectedWallet"
              render={({ field }) => (
                <Select value={field.value} onValueChange={field.onChange}>
                  <SelectTrigger
                    disabled={isLoadingWallets}
                    className={`${errors.selectedWallet ? 'border-red-500' : ''} ${isLoadingWallets ? 'opacity-50 cursor-not-allowed' : ''}`}
                  >
                    <SelectValue
                      placeholder={
                        isLoadingWallets ? 'Loading wallets...' : 'Select a minting wallet'
                      }
                    />
                  </SelectTrigger>
                  <SelectContent>
                    {sellingWallets.map((wallet) => (
                      <SelectItem
                        key={wallet.wallet.id}
                        value={wallet.wallet.walletVkey}
                        disabled={wallet.balance <= 3000000}
                      >
                        {wallet.wallet.note
                          ? `${wallet.wallet.note} (${shortenAddress(wallet.wallet.walletAddress)})`
                          : shortenAddress(wallet.wallet.walletAddress)}{' '}
                        {wallet.balance <= 3000000 ? ' - Insufficient balance' : ''}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            />
            {errors.selectedWallet && (
              <p className="text-sm text-red-500">{errors.selectedWallet.message}</p>
            )}
          </div>

          <div className="space-y-2">
            <label className="text-sm font-medium">Holding wallet</label>
            <Controller
              control={control}
              name="recipientWalletAddress"
              render={({ field }) => (
                <Select
                  value={field.value || '__default'}
                  onValueChange={(value) => field.onChange(value === '__default' ? '' : value)}
                >
                  <SelectTrigger
                    disabled={isLoadingWallets || !selectedPaymentSource}
                    className={isLoadingWallets ? 'opacity-50 cursor-not-allowed' : ''}
                  >
                    <SelectValue
                      placeholder={
                        !selectedPaymentSource
                          ? 'Select a minting wallet first'
                          : 'Use minting wallet (default)'
                      }
                    />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__default">Use minting wallet (default)</SelectItem>
                    {recipientWalletOptions.map((wallet) => (
                      <SelectItem key={wallet.id} value={wallet.walletAddress}>
                        {wallet.note
                          ? `${wallet.note} (${shortenAddress(wallet.walletAddress)})`
                          : shortenAddress(wallet.walletAddress)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            />
            <p className="text-xs text-muted-foreground">
              Optional. The minting wallet still funds and signs the mint transaction, while the
              inbox registry NFT is delivered to another managed holding wallet on the same payment
              source.
            </p>
            {selectedPaymentSource && recipientWalletOptions.length === 0 && (
              <p className="text-xs text-muted-foreground">
                No other managed wallets are available on this payment source.
              </p>
            )}
          </div>

          <div className="space-y-2">
            <label className="text-sm font-medium">Holding wallet funding (ADA)</label>
            <Input
              {...register('sendFundingAda')}
              type="number"
              inputMode="decimal"
              min="0"
              step="0.000001"
              placeholder="Optional ADA amount"
              disabled={!selectedRecipientWalletAddress}
              className={errors.sendFundingAda ? 'border-red-500' : ''}
            />
            <p className="text-xs text-muted-foreground">
              Optional. Sends ADA with the minted NFT to the selected holding wallet. The minimum
              NFT funding still applies.
            </p>
            {!selectedRecipientWalletAddress && (
              <p className="text-xs text-muted-foreground">
                Select a holding wallet to set a custom funding amount.
              </p>
            )}
            {errors.sendFundingAda && (
              <p className="text-sm text-red-500">{errors.sendFundingAda.message}</p>
            )}
          </div>

          <div className="flex justify-end gap-2">
            <Button variant="outline" type="button" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={isLoading || isLoadingWallets}>
              {isLoading ? 'Registering...' : 'Register'}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
