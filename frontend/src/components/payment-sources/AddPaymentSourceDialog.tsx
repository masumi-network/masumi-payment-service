import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { useEffect, useState } from 'react';
import { useAppContext } from '@/lib/contexts/AppContext';
import { postPaymentSourceExtended } from '@/lib/api/generated';
import { toast } from 'react-toastify';
import { X, Copy, Check } from 'lucide-react';
import { shortenAddress, copyToClipboard } from '@/lib/utils';
import {
  DEFAULT_ADMIN_WALLETS,
  DEFAULT_FEE_CONFIG,
} from '@/lib/constants/defaultWallets';
import { useForm, useFieldArray } from 'react-hook-form';
import { z } from 'zod';
import { zodResolver } from '@hookform/resolvers/zod';

interface AddPaymentSourceDialogProps {
  open: boolean;
  onClose: () => void;
  onSuccess: () => void;
}

const walletSchema = z.object({
  walletMnemonic: z.string().min(1, 'Mnemonic is required'),
  note: z.string().optional(),
  collectionAddress: z.string().optional(),
});

const adminWalletSchema = z.object({
  walletAddress: z.string().min(1, 'Admin wallet address is required'),
});

const formSchema = z.object({
  network: z.enum(['Mainnet', 'Preprod']),
  paymentType: z.literal('Web3CardanoV1'),
  blockfrostApiKey: z.string().min(1, 'Blockfrost API key is required'),
  feeReceiverWallet: z.object({
    walletAddress: z.string().min(1, 'Fee receiver wallet is required'),
  }),
  feePermille: z.number().min(0).max(1000),
  purchasingWallets: z.array(walletSchema).min(1),
  sellingWallets: z.array(walletSchema).min(1),
  useCustomAdminWallets: z.boolean(),
  customAdminWallets: z.tuple([
    adminWalletSchema,
    adminWalletSchema,
    adminWalletSchema,
  ]),
});

type FormSchema = z.infer<typeof formSchema>;

export function AddPaymentSourceDialog({
  open,
  onClose,
  onSuccess,
}: AddPaymentSourceDialogProps) {
  const { apiClient, state } = useAppContext();
  const [error, setError] = useState<string>('');
  const [isLoading, setIsLoading] = useState(false);
  const [copiedAddresses, setCopiedAddresses] = useState<{
    [key: string]: boolean;
  }>({});

  const {
    register,
    handleSubmit,
    control,
    watch,
    reset,
    formState: { errors },
  } = useForm<FormSchema>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      network: state.network,
      paymentType: 'Web3CardanoV1',
      blockfrostApiKey: '',
      feeReceiverWallet: {
        walletAddress: DEFAULT_FEE_CONFIG[state.network].feeWalletAddress,
      },
      feePermille: DEFAULT_FEE_CONFIG[state.network].feePermille,
      purchasingWallets: [
        { walletMnemonic: '', note: '', collectionAddress: '' },
      ],
      sellingWallets: [{ walletMnemonic: '', note: '', collectionAddress: '' }],
      useCustomAdminWallets: false,
      customAdminWallets: [
        { walletAddress: '' },
        { walletAddress: '' },
        { walletAddress: '' },
      ],
    },
  });

  // Field arrays for dynamic wallet lists
  const {
    fields: purchasingWalletFields,
    append: appendPurchasingWallet,
    remove: removePurchasingWallet,
  } = useFieldArray({
    control,
    name: 'purchasingWallets',
  });
  const {
    fields: sellingWalletFields,
    append: appendSellingWallet,
    remove: removeSellingWallet,
  } = useFieldArray({
    control,
    name: 'sellingWallets',
  });

  useEffect(() => {
    if (open) {
      reset({
        network: state.network,
        paymentType: 'Web3CardanoV1',
        blockfrostApiKey: '',
        feeReceiverWallet: {
          walletAddress: DEFAULT_FEE_CONFIG[state.network].feeWalletAddress,
        },
        feePermille: DEFAULT_FEE_CONFIG[state.network].feePermille,
        purchasingWallets: [
          { walletMnemonic: '', note: '', collectionAddress: '' },
        ],
        sellingWallets: [
          { walletMnemonic: '', note: '', collectionAddress: '' },
        ],
        useCustomAdminWallets: false,
        customAdminWallets: [
          { walletAddress: '' },
          { walletAddress: '' },
          { walletAddress: '' },
        ],
      });
      setError('');
    }
  }, [open, state.network, reset]);

  const handleCopy = async (address: string) => {
    await copyToClipboard(address);
    setCopiedAddresses({ ...copiedAddresses, [address]: true });
    setTimeout(() => {
      setCopiedAddresses((prev) => ({ ...prev, [address]: false }));
    }, 2000);
  };

  const onSubmit = async (data: FormSchema) => {
    setError('');
    setIsLoading(true);
    try {
      const adminWallets = data.useCustomAdminWallets
        ? data.customAdminWallets
        : DEFAULT_ADMIN_WALLETS[data.network];
      await postPaymentSourceExtended({
        client: apiClient,
        body: {
          network: data.network,
          paymentType: data.paymentType,
          PaymentSourceConfig: {
            rpcProviderApiKey: data.blockfrostApiKey,
            rpcProvider: 'Blockfrost',
          },
          feeRatePermille: data.feePermille,
          AdminWallets: adminWallets,
          FeeReceiverNetworkWallet: data.feeReceiverWallet,
          PurchasingWallets: data.purchasingWallets.map((w) => ({
            walletMnemonic: w.walletMnemonic,
            collectionAddress: w.collectionAddress?.trim() || null,
            note: w.note || '',
          })),
          SellingWallets: data.sellingWallets.map((w) => ({
            walletMnemonic: w.walletMnemonic,
            collectionAddress: w.collectionAddress?.trim() || null,
            note: w.note || '',
          })),
        },
      });
      toast.success('Payment source created successfully');
      onSuccess();
      onClose();
    } catch (error) {
      console.error('Error creating payment source:', error);
      setError(
        error instanceof Error
          ? error.message
          : 'Failed to create payment source',
      );
    } finally {
      setIsLoading(false);
    }
  };

  const useCustomAdminWallets = watch('useCustomAdminWallets');
  const network = watch('network');

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Add Payment Source</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit(onSubmit)} className="space-y-6 py-4">
          {error && <div className="text-sm text-destructive">{error}</div>}

          <div className="space-y-4">
            <h3 className="text-lg font-semibold">Basic Configuration</h3>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <label className="text-sm font-medium">
                  Network <span className="text-destructive">*</span>
                </label>
                <select
                  className="w-full p-2 rounded-md bg-background border"
                  {...register('network')}
                >
                  <option value="Preprod">Preprod</option>
                  <option value="Mainnet">Mainnet</option>
                </select>
                {errors.network && (
                  <p className="text-xs text-destructive mt-1">
                    {errors.network.message}
                  </p>
                )}
              </div>
              <div className="space-y-2">
                <label className="text-sm font-medium">
                  Blockfrost API Key <span className="text-destructive">*</span>
                </label>
                <input
                  type="text"
                  className="w-full p-2 rounded-md bg-background border"
                  {...register('blockfrostApiKey')}
                  placeholder="Using default Blockfrost API key"
                />
                {errors.blockfrostApiKey && (
                  <p className="text-xs text-destructive mt-1">
                    {errors.blockfrostApiKey.message}
                  </p>
                )}
              </div>
              <div className="space-y-2">
                <label className="text-sm font-medium">
                  Fee Permille <span className="text-destructive">*</span>
                </label>
                <input
                  type="number"
                  className="w-full p-2 rounded-md bg-background border"
                  {...register('feePermille', { valueAsNumber: true })}
                  min="0"
                  max="1000"
                />
                {errors.feePermille && (
                  <p className="text-xs text-destructive mt-1">
                    {errors.feePermille.message}
                  </p>
                )}
              </div>
            </div>
          </div>

          <div className="space-y-4">
            <h3 className="text-lg font-semibold">Fee Receiver Wallet</h3>
            <div className="space-y-2">
              <label className="text-sm font-medium">
                Wallet Address <span className="text-destructive">*</span>
              </label>
              <input
                type="text"
                className="w-full p-2 rounded-md bg-background border"
                {...register('feeReceiverWallet.walletAddress')}
                placeholder="Enter fee receiver wallet address"
              />
              {errors.feeReceiverWallet?.walletAddress && (
                <p className="text-xs text-destructive mt-1">
                  {errors.feeReceiverWallet.walletAddress.message}
                </p>
              )}
            </div>
          </div>

          <div className="space-y-4">
            <div className="flex justify-between items-center">
              <h3 className="text-lg font-semibold">Admin Wallets</h3>
              <div className="flex items-center gap-2">
                <label className="text-sm">Use Custom Admin Wallets</label>
                <input type="checkbox" {...register('useCustomAdminWallets')} />
              </div>
            </div>
            {useCustomAdminWallets ? (
              <div className="space-y-4">
                <div className="space-y-2">
                  <label className="text-sm font-medium">
                    Admin Wallet 1 <span className="text-destructive">*</span>
                  </label>
                  <input
                    type="text"
                    className="w-full p-2 rounded-md bg-background border"
                    {...register('customAdminWallets.0.walletAddress')}
                    placeholder="Enter admin wallet 1 address"
                  />
                  {errors.customAdminWallets &&
                    Array.isArray(errors.customAdminWallets) &&
                    errors.customAdminWallets[0]?.walletAddress && (
                      <p className="text-xs text-destructive mt-1">
                        {errors.customAdminWallets[0]?.walletAddress?.message}
                      </p>
                    )}
                </div>
                <div className="space-y-2">
                  <label className="text-sm font-medium">
                    Admin Wallet 2 <span className="text-destructive">*</span>
                  </label>
                  <input
                    type="text"
                    className="w-full p-2 rounded-md bg-background border"
                    {...register('customAdminWallets.1.walletAddress')}
                    placeholder="Enter admin wallet 2 address"
                  />
                  {errors.customAdminWallets &&
                    Array.isArray(errors.customAdminWallets) &&
                    errors.customAdminWallets[1]?.walletAddress && (
                      <p className="text-xs text-destructive mt-1">
                        {errors.customAdminWallets[1]?.walletAddress?.message}
                      </p>
                    )}
                </div>
                <div className="space-y-2">
                  <label className="text-sm font-medium">
                    Admin Wallet 3 <span className="text-destructive">*</span>
                  </label>
                  <input
                    type="text"
                    className="w-full p-2 rounded-md bg-background border"
                    {...register('customAdminWallets.2.walletAddress')}
                    placeholder="Enter admin wallet 3 address"
                  />
                  {errors.customAdminWallets &&
                    Array.isArray(errors.customAdminWallets) &&
                    errors.customAdminWallets[2]?.walletAddress && (
                      <p className="text-xs text-destructive mt-1">
                        {errors.customAdminWallets[2]?.walletAddress?.message}
                      </p>
                    )}
                </div>
                {errors.customAdminWallets &&
                  typeof errors.customAdminWallets.message === 'string' && (
                    <p className="text-xs text-destructive mt-1">
                      {errors.customAdminWallets.message}
                    </p>
                  )}
              </div>
            ) : (
              <div className="space-y-2">
                <p className="text-sm text-muted-foreground">
                  Using default admin wallets for {network}:
                </p>
                {DEFAULT_ADMIN_WALLETS[network].map((wallet, index) => (
                  <div
                    key={index}
                    className="flex items-center justify-between text-sm font-mono bg-muted p-2 rounded"
                  >
                    <div className="flex flex-col">
                      <span>{shortenAddress(wallet.walletAddress)}</span>
                      {wallet.note && (
                        <span className="text-xs text-muted-foreground">
                          {wallet.note}
                        </span>
                      )}
                    </div>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8"
                      onClick={() => handleCopy(wallet.walletAddress)}
                    >
                      {copiedAddresses[wallet.walletAddress] ? (
                        <Check className="h-4 w-4" />
                      ) : (
                        <Copy className="h-4 w-4" />
                      )}
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="space-y-4">
            <div className="flex justify-between items-center">
              <h3 className="text-lg font-semibold">Purchasing Wallets</h3>
              <Button
                type="button"
                variant="secondary"
                onClick={() =>
                  appendPurchasingWallet({
                    walletMnemonic: '',
                    note: '',
                    collectionAddress: '',
                  })
                }
              >
                Add Purchasing Wallet
              </Button>
            </div>
            {purchasingWalletFields.map((field, index) => (
              <div key={field.id} className="space-y-2 relative">
                <div className="text-sm font-medium flex items-center justify-start space-x-2">
                  <span>Purchasing Wallet {index + 1}</span>
                  {index > 0 && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8"
                      onClick={() => removePurchasingWallet(index)}
                    >
                      <X className="h-4 w-4" />
                    </Button>
                  )}
                </div>
                <div className="relative">
                  <input
                    type="text"
                    className="w-full p-2 rounded-md bg-background border"
                    {...register(
                      `purchasingWallets.${index}.walletMnemonic` as const,
                    )}
                    placeholder="Enter wallet mnemonic"
                  />
                  {errors.purchasingWallets?.[index]?.walletMnemonic && (
                    <p className="text-xs text-destructive mt-1">
                      {errors.purchasingWallets[index]?.walletMnemonic?.message}
                    </p>
                  )}
                </div>
                <input
                  type="text"
                  className="w-full p-2 rounded-md bg-background border"
                  {...register(`purchasingWallets.${index}.note` as const)}
                  placeholder="Note (optional)"
                />
                <input
                  type="text"
                  className="w-full p-2 rounded-md bg-background border"
                  {...register(
                    `purchasingWallets.${index}.collectionAddress` as const,
                  )}
                  placeholder="Collection Address (optional)"
                />
              </div>
            ))}
          </div>

          <div className="space-y-4">
            <div className="flex justify-between items-center">
              <h3 className="text-lg font-semibold">Selling Wallets</h3>
              <Button
                type="button"
                variant="secondary"
                onClick={() =>
                  appendSellingWallet({
                    walletMnemonic: '',
                    note: '',
                    collectionAddress: '',
                  })
                }
              >
                Add Selling Wallet
              </Button>
            </div>
            {sellingWalletFields.map((field, index) => (
              <div key={field.id} className="space-y-2 relative">
                <div className="text-sm font-medium flex items-center justify-start space-x-2">
                  <span>Selling Wallet {index + 1}</span>
                  {index > 0 && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8"
                      onClick={() => removeSellingWallet(index)}
                    >
                      <X className="h-4 w-4" />
                    </Button>
                  )}
                </div>
                <div className="relative">
                  <input
                    type="text"
                    className="w-full p-2 rounded-md bg-background border"
                    {...register(
                      `sellingWallets.${index}.walletMnemonic` as const,
                    )}
                    placeholder="Enter wallet mnemonic"
                  />
                  {errors.sellingWallets?.[index]?.walletMnemonic && (
                    <p className="text-xs text-destructive mt-1">
                      {errors.sellingWallets[index]?.walletMnemonic?.message}
                    </p>
                  )}
                </div>
                <input
                  type="text"
                  className="w-full p-2 rounded-md bg-background border"
                  {...register(`sellingWallets.${index}.note` as const)}
                  placeholder="Note (optional)"
                />
                <input
                  type="text"
                  className="w-full p-2 rounded-md bg-background border"
                  {...register(
                    `sellingWallets.${index}.collectionAddress` as const,
                  )}
                  placeholder="Collection Address (optional)"
                />
              </div>
            ))}
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
              {isLoading ? 'Adding...' : 'Add Payment Source'}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
