/* eslint-disable @typescript-eslint/no-explicit-any */
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { useEffect, useState } from 'react';
import { useAppContext } from '@/lib/contexts/AppContext';
import { postPaymentSourceExtended, postWallet } from '@/lib/api/generated';
import { toast } from 'react-toastify';
import { X, Copy, Check } from 'lucide-react';
import { shortenAddress, copyToClipboard, handleApiCall } from '@/lib/utils';
import {
  DEFAULT_ADMIN_WALLETS,
  DEFAULT_FEE_CONFIG,
} from '@/lib/constants/defaultWallets';
import { useForm, useFieldArray } from 'react-hook-form';
import { z } from 'zod';
import { zodResolver } from '@hookform/resolvers/zod';
import { Spinner } from '../ui/spinner';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { TOOLTIP_TEXTS } from '@/lib/constants/tooltips';
import { HelpCircle } from 'lucide-react';

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

const formSchema = z
  .object({
    network: z.enum(['Mainnet', 'Preprod']),
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
  })
  .superRefine((data, ctx) => {
    if (data.useCustomAdminWallets) {
      data.customAdminWallets.forEach((wallet, i) => {
        if (!wallet.walletAddress || wallet.walletAddress.length === 0) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: 'Admin wallet address is required',
            path: ['customAdminWallets', i, 'walletAddress'],
          });
        }
      });
    }
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
  const [generatingPurchasing, setGeneratingPurchasing] = useState<{
    [key: number]: boolean;
  }>({});
  const [generatingSelling, setGeneratingSelling] = useState<{
    [key: number]: boolean;
  }>({});
  const [walletGenError, setWalletGenError] = useState<string>('');

  const {
    register,
    handleSubmit,
    control,
    watch,
    reset,
    formState: { errors },
    setValue,
  } = useForm<FormSchema>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      network: state.network,
      blockfrostApiKey: '',
      feeReceiverWallet: {
        walletAddress: '',
      },
      feePermille: DEFAULT_FEE_CONFIG[state.network].feePermille,
      purchasingWallets: [
        { walletMnemonic: '', note: '', collectionAddress: '' },
      ],
      sellingWallets: [{ walletMnemonic: '', note: '', collectionAddress: '' }],
      useCustomAdminWallets: false,
      customAdminWallets: [
        {
          walletAddress: DEFAULT_ADMIN_WALLETS[state.network][0].walletAddress,
        },
        {
          walletAddress: DEFAULT_ADMIN_WALLETS[state.network][1].walletAddress,
        },
        {
          walletAddress: DEFAULT_ADMIN_WALLETS[state.network][2].walletAddress,
        },
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
          {
            walletAddress:
              DEFAULT_ADMIN_WALLETS[state.network][0].walletAddress,
          },
          {
            walletAddress:
              DEFAULT_ADMIN_WALLETS[state.network][1].walletAddress,
          },
          {
            walletAddress:
              DEFAULT_ADMIN_WALLETS[state.network][2].walletAddress,
          },
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

    const adminWallets = data.useCustomAdminWallets
      ? data.customAdminWallets
      : DEFAULT_ADMIN_WALLETS[data.network];

    await handleApiCall(
      () =>
        postPaymentSourceExtended({
          client: apiClient,
          body: {
            network: data.network,
            PaymentSourceConfig: {
              rpcProviderApiKey: data.blockfrostApiKey,
              rpcProvider: 'Blockfrost',
            },
            feeRatePermille: data.feePermille,
            AdminWallets: adminWallets.map((w) => ({
              walletAddress: w.walletAddress,
            })) as [
              { walletAddress: string },
              { walletAddress: string },
              { walletAddress: string },
            ],
            FeeReceiverNetworkWallet: data.feeReceiverWallet,
            PurchasingWallets: data.purchasingWallets.map((wallet) => ({
              walletMnemonic: wallet.walletMnemonic,
              collectionAddress: wallet.collectionAddress || null,
              note: wallet.note || '',
            })),
            SellingWallets: data.sellingWallets.map((wallet) => ({
              walletMnemonic: wallet.walletMnemonic,
              collectionAddress: wallet.collectionAddress || null,
              note: wallet.note || '',
            })),
          },
        }),
      {
        onSuccess: () => {
          toast.success('Payment source created successfully');
          onSuccess();
          onClose();
        },
        onError: (error: any) => {
          const errorMessage =
            error.message ||
            error.error?.message ||
            'Failed to create payment source';
          setError(errorMessage);
        },
        onFinally: () => {
          setIsLoading(false);
        },
        errorMessage: 'Failed to create payment source',
      },
    );
  };

  const useCustomAdminWallets = watch('useCustomAdminWallets');
  const network = watch('network');

  // Handler to generate mnemonic for a purchasing wallet
  const handleGeneratePurchasingMnemonic = async (index: number) => {
    setWalletGenError('');
    setGeneratingPurchasing((prev) => ({ ...prev, [index]: true }));
    await handleApiCall(
      () =>
        postWallet({
          client: apiClient,
          body: { network: watch('network') },
        }),
      {
        onSuccess: (response: any) => {
          if (response.data?.data?.walletMnemonic) {
            // Set the mnemonic in the form
            const fieldName =
              `purchasingWallets.${index}.walletMnemonic` as const;
            setValue(fieldName, response.data.data.walletMnemonic);
          } else {
            setWalletGenError('Failed to generate mnemonic phrase');
            toast.error('Failed to generate mnemonic phrase');
          }
        },
        onError: (error: any) => {
          setWalletGenError(error?.message || 'Failed to generate mnemonic');
          toast.error(error?.message || 'Failed to generate mnemonic');
        },
        onFinally: () => {
          setGeneratingPurchasing((prev) => ({ ...prev, [index]: false }));
        },
        errorMessage: 'Failed to generate mnemonic',
      },
    );
  };
  // Handler to generate mnemonic for a selling wallet
  const handleGenerateSellingMnemonic = async (index: number) => {
    setWalletGenError('');
    setGeneratingSelling((prev) => ({ ...prev, [index]: true }));
    await handleApiCall(
      () =>
        postWallet({
          client: apiClient,
          body: { network: watch('network') },
        }),
      {
        onSuccess: (response: any) => {
          if (response.data?.data?.walletMnemonic) {
            const fieldName = `sellingWallets.${index}.walletMnemonic` as const;
            setValue(fieldName, response.data.data.walletMnemonic);
          } else {
            setWalletGenError('Failed to generate mnemonic phrase');
            toast.error('Failed to generate mnemonic phrase');
          }
        },
        onError: (error: any) => {
          setWalletGenError(error?.message || 'Failed to generate mnemonic');
          toast.error(error?.message || 'Failed to generate mnemonic');
        },
        onFinally: () => {
          setGeneratingSelling((prev) => ({ ...prev, [index]: false }));
        },
        errorMessage: 'Failed to generate mnemonic',
      },
    );
  };

  type AdminWalletPath = `customAdminWallets.${0 | 1 | 2}.walletAddress`;

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Add Payment Source</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit(onSubmit)} className="space-y-6 py-4">
          <div className="space-y-4">
            <h3 className="text-lg font-semibold">Basic Configuration</h3>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <div className="flex items-center gap-2">
                  <label className="text-sm font-medium">
                    Network <span className="text-red-500">*</span>
                  </label>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <HelpCircle className="h-3 w-3 text-muted-foreground cursor-help" />
                    </TooltipTrigger>
                    <TooltipContent>
                      <p>{TOOLTIP_TEXTS.NETWORK}</p>
                    </TooltipContent>
                  </Tooltip>
                </div>
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
                <div className="flex items-center gap-2">
                  <label className="text-sm font-medium">
                    Blockfrost API Key{' '}
                    <span className="text-destructive">*</span>
                  </label>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <HelpCircle className="h-3 w-3 text-muted-foreground cursor-help" />
                    </TooltipTrigger>
                    <TooltipContent>
                      <p>{TOOLTIP_TEXTS.BLOCKFROST_API_KEY}</p>
                    </TooltipContent>
                  </Tooltip>
                </div>
                <input
                  type="text"
                  className="w-full p-2 rounded-md bg-background border"
                  {...register('blockfrostApiKey')}
                  placeholder="Enter your Blockfrost API key"
                />
                {errors.blockfrostApiKey && (
                  <p className="text-xs text-destructive mt-1">
                    {errors.blockfrostApiKey.message}
                  </p>
                )}
              </div>
              <div className="space-y-2">
                <div className="flex items-center gap-2">
                  <label className="text-sm font-medium">
                    Fee Permille <span className="text-red-500">*</span>
                  </label>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <HelpCircle className="h-3 w-3 text-muted-foreground cursor-help" />
                    </TooltipTrigger>
                    <TooltipContent>
                      <p>{TOOLTIP_TEXTS.FEE_PERMILLE}</p>
                    </TooltipContent>
                  </Tooltip>
                </div>
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
            <div className="flex items-center gap-2">
              <h3 className="text-lg font-semibold">Fee Receiver Wallet</h3>
              <Tooltip>
                <TooltipTrigger asChild>
                  <HelpCircle className="h-4 w-4 text-muted-foreground cursor-help" />
                </TooltipTrigger>
                <TooltipContent>
                  <p>{TOOLTIP_TEXTS.FEE_RECEIVER_WALLET}</p>
                </TooltipContent>
              </Tooltip>
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium">
                Wallet Address <span className="text-red-500">*</span>
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
              <div className="flex items-center gap-2">
                <h3 className="text-lg font-semibold">Admin Wallets</h3>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <HelpCircle className="h-4 w-4 text-muted-foreground cursor-help" />
                  </TooltipTrigger>
                  <TooltipContent>
                    <p>{TOOLTIP_TEXTS.ADMIN_WALLETS}</p>
                  </TooltipContent>
                </Tooltip>
              </div>
              <div className="flex items-center gap-2">
                <label className="text-sm">Use Custom Admin Wallets</label>
                <input type="checkbox" {...register('useCustomAdminWallets')} />
              </div>
            </div>
            {useCustomAdminWallets ? (
              <div className="space-y-4">
                {[0, 1, 2].map((i) => (
                  <div key={i} className="space-y-2">
                    <label className="text-sm font-medium">
                      Admin Wallet {i + 1}{' '}
                      <span className="text-destructive">*</span>
                    </label>
                    <input
                      type="text"
                      className="w-full p-2 rounded-md bg-background border"
                      {...register(
                        `customAdminWallets.${i}.walletAddress` as AdminWalletPath,
                      )}
                      placeholder="Enter admin wallet address"
                    />
                    {errors.customAdminWallets?.[i]?.walletAddress && (
                      <p className="text-xs text-destructive mt-1">
                        {errors.customAdminWallets[i].walletAddress.message}
                      </p>
                    )}
                  </div>
                ))}
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
              <div className="flex items-center gap-2">
                <h3 className="text-lg font-semibold">Purchasing Wallets</h3>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <HelpCircle className="h-4 w-4 text-muted-foreground cursor-help" />
                  </TooltipTrigger>
                  <TooltipContent>
                    <p>{TOOLTIP_TEXTS.PURCHASING_WALLETS}</p>
                  </TooltipContent>
                </Tooltip>
              </div>
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
                <div className="relative flex items-center gap-2">
                  <input
                    type="text"
                    className="w-full p-2 rounded-md bg-background border"
                    {...register(
                      `purchasingWallets.${index}.walletMnemonic` as const,
                    )}
                    placeholder="Enter wallet mnemonic"
                  />
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="h-8"
                    onClick={() => handleGeneratePurchasingMnemonic(index)}
                    disabled={!!generatingPurchasing[index]}
                    aria-label="Generate mnemonic"
                  >
                    {generatingPurchasing[index] ? <Spinner /> : 'Generate'}
                  </Button>
                </div>
                {errors.purchasingWallets?.[index]?.walletMnemonic && (
                  <p className="text-xs text-destructive mt-1">
                    {errors.purchasingWallets[index]?.walletMnemonic?.message}
                  </p>
                )}
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
              <div className="flex items-center gap-2">
                <h3 className="text-lg font-semibold">Selling Wallets</h3>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <HelpCircle className="h-4 w-4 text-muted-foreground cursor-help" />
                  </TooltipTrigger>
                  <TooltipContent>
                    <p>{TOOLTIP_TEXTS.SELLING_WALLETS}</p>
                  </TooltipContent>
                </Tooltip>
              </div>
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
                <div className="relative flex items-center gap-2">
                  <input
                    type="text"
                    className="w-full p-2 rounded-md bg-background border"
                    {...register(
                      `sellingWallets.${index}.walletMnemonic` as const,
                    )}
                    placeholder="Enter wallet mnemonic"
                  />
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="h-8"
                    onClick={() => handleGenerateSellingMnemonic(index)}
                    disabled={!!generatingSelling[index]}
                    aria-label="Generate mnemonic"
                  >
                    {generatingSelling[index] ? <Spinner /> : 'Generate'}
                  </Button>
                </div>
                {errors.sellingWallets?.[index]?.walletMnemonic && (
                  <p className="text-xs text-destructive mt-1">
                    {errors.sellingWallets[index]?.walletMnemonic?.message}
                  </p>
                )}
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

          {walletGenError && (
            <div className="text-xs text-destructive mt-1">
              {walletGenError}
            </div>
          )}

          {Object.keys(errors).length > 0 && (
            <div className="text-sm text-destructive mt-4 p-3 bg-destructive/10 rounded-md">
              <p className="font-medium mb-1">
                Please fix the following errors:
              </p>
              <ul className="list-disc list-inside space-y-1">
                {errors.network && <li>{errors.network.message}</li>}
                {errors.blockfrostApiKey && (
                  <li>{errors.blockfrostApiKey.message}</li>
                )}
                {errors.feeReceiverWallet?.walletAddress && (
                  <li>
                    Fee receiver wallet:{' '}
                    {errors.feeReceiverWallet.walletAddress.message}
                  </li>
                )}
                {errors.feePermille && <li>{errors.feePermille.message}</li>}
                {errors.purchasingWallets && (
                  <li>At least one purchasing wallet is required</li>
                )}
                {errors.sellingWallets && (
                  <li>At least one selling wallet is required</li>
                )}
                {errors.customAdminWallets && (
                  <li>
                    All admin wallet addresses are required when using custom
                    admin wallets
                  </li>
                )}
              </ul>
            </div>
          )}

          {error && (
            <div className="text-md text-destructive mt-4">{error}</div>
          )}

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
