/* eslint-disable react/no-unescaped-entities */

import { Button } from '@/components/ui/button';
import { useState, useEffect } from 'react';
import { Checkbox } from '@/components/ui/checkbox';
import { Badge } from '@/components/ui/badge';
import { toast } from 'react-toastify';
import { Download, Copy, ArrowRight, Trash2 } from 'lucide-react';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import router from 'next/router';
import { Spinner } from '@/components/ui/spinner';
import { useAppContext } from '@/lib/contexts/AppContext';
import {
  postWallet,
  postPaymentSourceExtended,
  postRegistry,
  getPaymentSourceExtended,
} from '@/lib/api/generated';
import { handleApiCall, shortenAddress, getExplorerUrl } from '@/lib/utils';
import { DEFAULT_ADMIN_WALLETS, DEFAULT_FEE_CONFIG } from '@/lib/constants/defaultWallets';
import { useForm, useFieldArray } from 'react-hook-form';
import { z } from 'zod';
import { zodResolver } from '@hookform/resolvers/zod';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Separator } from '@/components/ui/separator';
import { getUsdmConfig } from '@/lib/constants/defaultWallets';

function formatNetworkDisplay(networkType: string): string {
  return networkType?.toUpperCase() === 'MAINNET' ? 'Mainnet' : 'Preprod';
}

function WelcomeScreen({
  onStart,
  networkType,
  onNetworkChange,
}: {
  onStart: () => void;
  networkType: string;
  onNetworkChange: (network: 'Preprod' | 'Mainnet') => void;
}) {
  const networkDisplay = formatNetworkDisplay(networkType);

  return (
    <div className="text-center space-y-4 max-w-[600px]">
      <h1 className="text-4xl font-bold">Welcome!</h1>
      <h2 className="text-3xl font-bold">
        Let&apos;s set up your
        <br />
        {networkDisplay} environment
      </h2>

      <p className="text-sm text-muted-foreground mt-4 mb-8 text-center max-w-md">
        We'll help you set up your payment environment by creating secure wallets, configuring
        payment sources, and setting up your first AI agent.
      </p>

      <div className="flex items-center justify-center gap-4 mt-8">
        <div className="relative">
          <div className="text-sm flex items-center gap-2">
            <span>Network:</span>
            <Select
              value={networkDisplay}
              onValueChange={(value) => onNetworkChange(value as 'Preprod' | 'Mainnet')}
            >
              <SelectTrigger className="w-[140px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent align="start">
                <SelectItem value="Preprod">Preprod</SelectItem>
                <SelectItem value="Mainnet">Mainnet</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
        <Button className="text-sm" onClick={onStart}>
          Start setup <ArrowRight className="w-4 h-4" />
        </Button>
      </div>
    </div>
  );
}

function SeedPhrasesScreen({
  onNext,
  ignoreSetup,
}: {
  onNext: (
    buyingWallet: { address: string; mnemonic: string },
    sellingWallet: { address: string; mnemonic: string },
  ) => void;
  ignoreSetup: () => void;
}) {
  const { apiClient, network } = useAppContext();
  const [isConfirmed, setIsConfirmed] = useState(false);
  const [isGenerating, setIsGenerating] = useState(true);
  const [buyingWallet, setBuyingWallet] = useState<{
    address: string;
    mnemonic: string;
  } | null>(null);
  const [sellingWallet, setSellingWallet] = useState<{
    address: string;
    mnemonic: string;
  } | null>(null);
  const [error, setError] = useState<string>('');

  const handleCopy = (text: string) => {
    navigator.clipboard.writeText(text);
    toast.success('Copied to clipboard');
  };

  useEffect(() => {
    const generateWallets = async () => {
      setIsGenerating(true);
      setError('');

      const buyingResponse: any = await handleApiCall(
        () =>
          postWallet({
            client: apiClient,
            body: {
              network: network,
            },
          }),
        {
          onError: (error: any) => {
            setError(error.message || 'Failed to generate buying wallet');
            toast.error('Failed to generate buying wallet');
          },
          onFinally: () => {
            setIsGenerating(false);
          },
          errorMessage: 'Failed to generate buying wallet',
        },
      );

      if (!buyingResponse) return;

      if (
        !buyingResponse?.data?.data?.walletMnemonic ||
        !buyingResponse?.data?.data?.walletAddress
      ) {
        setError('Failed to generate buying wallet');
        toast.error('Failed to generate buying wallet');
        return;
      }

      setBuyingWallet({
        address: buyingResponse.data.data.walletAddress,
        mnemonic: buyingResponse.data.data.walletMnemonic,
      });

      const sellingResponse: any = await handleApiCall(
        () =>
          postWallet({
            client: apiClient,
            body: {
              network: network,
            },
          }),
        {
          onError: (error: any) => {
            setError(error.message || 'Failed to generate selling wallet');
            toast.error('Failed to generate selling wallet');
          },
          onFinally: () => {
            setIsGenerating(false);
          },
          errorMessage: 'Failed to generate selling wallet',
        },
      );

      if (!sellingResponse) return;

      if (
        !sellingResponse?.data?.data?.walletMnemonic ||
        !sellingResponse?.data?.data?.walletAddress
      ) {
        setError('Failed to generate selling wallet');
        toast.error('Failed to generate selling wallet');
        return;
      }

      setSellingWallet({
        address: sellingResponse.data.data.walletAddress,
        mnemonic: sellingResponse.data.data.walletMnemonic,
      });
    };

    generateWallets();
  }, [apiClient, network]);

  return (
    <div className="space-y-6 max-w-[600px] w-full">
      <div className="text-center space-y-4">
        <h1 className="text-4xl font-bold">Save seed phrases</h1>
        <p className="text-sm text-muted-foreground">
          Please save these seed phrases securely. You will need them to access your wallets.
        </p>
      </div>

      {error && <div className="text-sm text-destructive text-center">{error}</div>}

      <div className="space-y-6 w-full">
        <div className="rounded-lg border border-border p-4 space-y-4">
          <div className="flex items-center gap-2">
            <span className="text-xs font-medium px-2 py-0.5 rounded-full bg-black text-white dark:bg-white/10 dark:text-white">
              Buying
            </span>
            <h3 className="text-sm font-medium">Buying wallet</h3>
          </div>
          {isGenerating ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Spinner size={16} />
              Generating...
            </div>
          ) : (
            buyingWallet && (
              <div className="space-y-4">
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8"
                    onClick={() => handleCopy(buyingWallet.address)}
                  >
                    <Copy className="h-4 w-4" />
                  </Button>
                  {shortenAddress(buyingWallet.address, 10)}
                </div>
                <div className="border-t border-border my-4" />
                <div>
                  <div className="text-sm font-medium mb-2">Seed phrase</div>
                  <div className="flex flex-col gap-4">
                    <div className="flex items-center gap-2">
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8"
                        onClick={() => handleCopy(buyingWallet.mnemonic)}
                      >
                        <Copy className="h-4 w-4" />
                      </Button>
                      <div className="flex-1 font-mono text-sm text-muted-foreground">
                        {buyingWallet.mnemonic}
                      </div>
                    </div>
                    <div className="flex gap-2">
                      <Button
                        className="text-sm flex items-center gap-2 bg-black text-white hover:bg-black/90"
                        onClick={() => {
                          const blob = new Blob([buyingWallet.mnemonic], {
                            type: 'text/plain',
                          });
                          const url = window.URL.createObjectURL(blob);
                          const a = document.createElement('a');
                          a.href = url;
                          a.download = 'buying-wallet-seed.txt';
                          a.click();
                          window.URL.revokeObjectURL(url);
                        }}
                      >
                        <Download className="h-4 w-4" />
                        Download
                      </Button>
                    </div>
                  </div>
                </div>
              </div>
            )
          )}
        </div>

        <div className="rounded-lg border border-border p-4 space-y-4">
          <div className="flex items-center gap-2">
            <span className="text-xs font-medium px-2 py-0.5 rounded-full bg-[#FFF7ED] text-[#C2410C] dark:bg-[#C2410C]/10 dark:text-[#FFF7ED]">
              Selling
            </span>
            <h3 className="text-sm font-medium">Selling wallet</h3>
          </div>
          {isGenerating ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Spinner size={16} />
              Generating...
            </div>
          ) : (
            sellingWallet && (
              <div className="space-y-4">
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8"
                    onClick={() => handleCopy(sellingWallet.address)}
                  >
                    <Copy className="h-4 w-4" />
                  </Button>
                  {shortenAddress(sellingWallet.address, 10)}
                </div>
                <div className="border-t border-border my-4" />
                <div>
                  <div className="text-sm font-medium mb-2">Seed phrase</div>
                  <div className="flex flex-col gap-4">
                    <div className="flex items-center gap-2">
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8"
                        onClick={() => handleCopy(sellingWallet.mnemonic)}
                      >
                        <Copy className="h-4 w-4" />
                      </Button>
                      <div className="flex-1 font-mono text-sm text-muted-foreground">
                        {sellingWallet.mnemonic}
                      </div>
                    </div>
                    <div className="flex gap-2">
                      <Button
                        className="text-sm flex items-center gap-2 bg-black text-white hover:bg-black/90"
                        onClick={() => {
                          const blob = new Blob([sellingWallet.mnemonic], {
                            type: 'text/plain',
                          });
                          const url = window.URL.createObjectURL(blob);
                          const a = document.createElement('a');
                          a.href = url;
                          a.download = 'selling-wallet-seed.txt';
                          a.click();
                          window.URL.revokeObjectURL(url);
                        }}
                      >
                        <Download className="h-4 w-4" />
                        Download
                      </Button>
                    </div>
                  </div>
                </div>
              </div>
            )
          )}
        </div>

        <div className="flex items-center gap-2">
          <Checkbox
            id="confirm"
            checked={isConfirmed}
            onCheckedChange={(checked) => setIsConfirmed(checked as boolean)}
            disabled={isGenerating}
          />
          <label htmlFor="confirm" className="text-sm text-muted-foreground">
            I saved both seed phrases in a secure place
          </label>
        </div>

        <div className="flex items-center justify-center gap-4 pt-4">
          <Button variant="secondary" className="text-sm" onClick={ignoreSetup}>
            Cancel
          </Button>
          <Button
            className="text-sm"
            disabled={isGenerating || !isConfirmed || !buyingWallet || !sellingWallet}
            onClick={() => {
              if (buyingWallet && sellingWallet) {
                onNext(buyingWallet, sellingWallet);
              }
            }}
          >
            {isGenerating ? 'Generating...' : 'Next'}
          </Button>
        </div>
      </div>
    </div>
  );
}

const paymentSourceSchema = z.object({
  blockfrostApiKey: z.string().min(1, 'Blockfrost API key is required'),
  feeReceiverWallet: z.object({
    walletAddress: z.string().min(1, 'Fee receiver wallet is required'),
  }),
  feePermille: z.number().min(0).max(1000),
});

type PaymentSourceFormValues = z.infer<typeof paymentSourceSchema>;

function PaymentSourceSetupScreen({
  onNext,
  buyingWallet,
  sellingWallet,
  ignoreSetup,
}: {
  onNext: () => void;
  buyingWallet: { address: string; mnemonic: string } | null;
  sellingWallet: { address: string; mnemonic: string } | null;
  ignoreSetup: () => void;
}) {
  const { apiClient, network } = useAppContext();
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string>('');

  const adminWallets = DEFAULT_ADMIN_WALLETS[network];

  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<PaymentSourceFormValues>({
    resolver: zodResolver(paymentSourceSchema),
    defaultValues: {
      blockfrostApiKey: '',
      feeReceiverWallet: {
        walletAddress: DEFAULT_FEE_CONFIG[network].feeWalletAddress,
      },
      feePermille: DEFAULT_FEE_CONFIG[network].feePermille,
    },
  });

  const handleCopy = (text: string) => {
    navigator.clipboard.writeText(text);
    toast.success('Copied to clipboard');
  };

  const onSubmit = async (data: PaymentSourceFormValues) => {
    if (!buyingWallet || !sellingWallet) {
      setError('Buying and selling wallets are required');
      return;
    }

    setIsLoading(true);
    setError('');

    await handleApiCall(
      () =>
        postPaymentSourceExtended({
          client: apiClient,
          body: {
            network: network,
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
            PurchasingWallets: [
              {
                walletMnemonic: buyingWallet.mnemonic,
                collectionAddress: null,
                note: 'Setup Buying Wallet',
              },
            ],
            SellingWallets: [
              {
                walletMnemonic: sellingWallet.mnemonic,
                collectionAddress: null,
                note: 'Setup Selling Wallet',
              },
            ],
          },
        }),
      {
        onSuccess: () => {
          toast.success('Payment source created successfully');
          onNext();
        },
        onError: (error: any) => {
          setError(error.message || 'Failed to create payment source');
          toast.error(error.message || 'Failed to create payment source');
        },
        onFinally: () => {
          setIsLoading(false);
        },
        errorMessage: 'Failed to create payment source',
      },
    );
  };

  return (
    <div className="space-y-6 max-w-[600px] w-full">
      <div className="text-center space-y-4">
        <h1 className="text-4xl font-bold">Setup Payment Source</h1>
        <p className="text-sm text-muted-foreground">
          Configure your payment source with the generated wallets.
        </p>
      </div>

      {error && <div className="text-sm text-destructive text-center">{error}</div>}

      <div className="space-y-6">
        {/* Admin Wallets Section */}
        <div className="space-y-4">
          <h3 className="text-lg font-semibold">Admin Wallets</h3>
          <div className="space-y-4">
            {adminWallets.map((wallet, index) => (
              <div key={index} className="rounded-lg border border-border p-4 space-y-4">
                <div className="flex items-center gap-2">
                  <span className="text-xs font-medium px-2 py-0.5 rounded-full bg-black text-white dark:bg-white/10 dark:text-white">
                    Admin Wallet {index + 1}
                  </span>
                </div>
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8"
                    onClick={() => handleCopy(wallet.walletAddress)}
                  >
                    <Copy className="h-4 w-4" />
                  </Button>
                  {shortenAddress(wallet.walletAddress, 10)}
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Configuration Section */}
        <div className="space-y-4">
          <h3 className="text-lg font-semibold">Configuration</h3>
          <form onSubmit={handleSubmit(onSubmit)} className="grid gap-4">
            <div className="space-y-2">
              <label className="text-sm font-medium">
                Blockfrost API Key <span className="text-destructive">*</span>
              </label>
              <input
                type="text"
                className="w-full p-2 rounded-md bg-background border"
                {...register('blockfrostApiKey')}
                placeholder="Enter your Blockfrost API key"
              />
              {errors.blockfrostApiKey && (
                <p className="text-xs text-destructive mt-1">{errors.blockfrostApiKey.message}</p>
              )}
            </div>

            <div className="space-y-2">
              <label className="text-sm font-medium">
                Fee Receiver Wallet Address <span className="text-destructive">*</span>
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
                <p className="text-xs text-destructive mt-1">{errors.feePermille.message}</p>
              )}
            </div>

            <div className="flex items-center justify-center gap-4 pt-4">
              <Button variant="secondary" className="text-sm" type="button" onClick={ignoreSetup}>
                Cancel
              </Button>
              <Button className="text-sm" disabled={isLoading} type="submit">
                {isLoading ? 'Creating...' : 'Create Payment Source'}
              </Button>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
}

function AddAiAgentScreen({
  onNext,
  sellingWallet,
  ignoreSetup,
  onAgentCreated,
}: {
  onNext: () => void;
  sellingWallet: { address: string; mnemonic: string } | null;
  ignoreSetup: () => void;
  onAgentCreated?: () => void;
}) {
  const { apiClient, network } = useAppContext();
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string>('');

  const priceSchema = z.object({
    unit: z.enum(['lovelace', 'USDM'] as const, {
      error: () => 'Token is required',
    }),
    amount: z.string().refine((val) => {
      if (val === '0' || val === '0.0' || val === '0.00') return true;
      return !isNaN(parseFloat(val)) && parseFloat(val) >= 0;
    }, 'Amount must be a valid number >= 0'),
  });

  const agentSchema = z.object({
    apiUrl: z
      .string()
      .url('API URL must be a valid URL')
      .min(1, 'API URL is required')
      .refine((val) => val.startsWith('http://') || val.startsWith('https://'), {
        message: 'API URL must start with http:// or https://',
      }),
    name: z.string().min(1, 'Name is required'),
    description: z
      .string()
      .min(1, 'Description is required')
      .max(250, 'Description must be less than 250 characters'),
    prices: z.array(priceSchema).min(1, 'At least one price is required'),
    tags: z.array(z.string().min(1)).min(1, 'At least one tag is required'),
    isFree: z.boolean().optional(),
    // Additional Fields
    authorName: z
      .string()
      .max(250, 'Author name must be less than 250 characters')
      .optional()
      .or(z.literal('')),
    authorEmail: z
      .string()
      .email('Author email must be a valid email')
      .max(250, 'Author email must be less than 250 characters')
      .optional()
      .or(z.literal('')),
    organization: z
      .string()
      .max(250, 'Organization must be less than 250 characters')
      .optional()
      .or(z.literal('')),
    contactOther: z
      .string()
      .max(250, 'Contact other must be less than 250 characters')
      .optional()
      .or(z.literal('')),
    termsOfUseUrl: z
      .string()
      .url('Terms of use URL must be a valid URL')
      .optional()
      .or(z.literal('')),
    privacyPolicyUrl: z
      .string()
      .url('Privacy policy URL must be a valid URL')
      .optional()
      .or(z.literal('')),
    otherUrl: z.string().url('Other URL must be a valid URL').optional().or(z.literal('')),
    capabilityName: z
      .string()
      .max(250, 'Capability name must be less than 250 characters')
      .optional()
      .or(z.literal('')),
    capabilityVersion: z
      .string()
      .max(50, 'Capability version must be less than 50 characters')
      .optional()
      .or(z.literal('')),
  });

  type AgentFormValues = z.infer<typeof agentSchema>;

  const {
    register,
    handleSubmit,
    control,
    setValue,
    formState: { errors },
    watch,
  } = useForm<AgentFormValues>({
    resolver: zodResolver(agentSchema),
    defaultValues: {
      apiUrl: '',
      name: '',
      description: '',
      prices: [{ unit: 'lovelace', amount: '' }],
      tags: [],
      isFree: false,
      authorName: '',
      authorEmail: '',
      organization: '',
      contactOther: '',
      termsOfUseUrl: '',
      privacyPolicyUrl: '',
      otherUrl: '',
      capabilityName: '',
      capabilityVersion: '',
    },
  });

  const {
    fields: priceFields,
    append: appendPrice,
    remove: removePrice,
  } = useFieldArray({
    control,
    name: 'prices',
  });

  const tags = watch('tags');
  const [tagInput, setTagInput] = useState('');

  const onSubmit = async (data: AgentFormValues) => {
    if (!sellingWallet) {
      setError('No selling wallet available');
      return;
    }

    setIsLoading(true);
    setError('');

    try {
      // Fetch payment sources to get the latest data
      const response = await getPaymentSourceExtended({
        client: apiClient,
        query: {
          take: 10,
        },
      });

      if (response.error) {
        const error = response.error as { message: string };
        setError(error.message || 'Failed to fetch payment sources');
        return;
      }

      const paymentSources = response.data?.data?.ExtendedPaymentSources ?? [];
      const filteredSources = paymentSources.filter((source: any) => source.network == network);

      if (filteredSources.length === 0) {
        setError('No payment sources found for this network');
        return;
      }

      // Use the first payment source (most recent)
      const paymentSource = filteredSources[0];

      const sellingWalletData = paymentSource.SellingWallets?.find(
        (s: any) => s.walletAddress === sellingWallet.address,
      );

      if (!sellingWalletData?.walletVkey) {
        setError('Selling wallet vKey not found');
        return;
      }

      const registryResponse = await postRegistry({
        client: apiClient,
        body: {
          network: network,
          sellingWalletVkey: sellingWalletData.walletVkey,
          name: data.name,
          description: data.description,
          apiBaseUrl: data.apiUrl,
          Tags: data.tags,
          Capability:
            data.capabilityName && data.capabilityVersion
              ? { name: data.capabilityName, version: data.capabilityVersion }
              : { name: 'Custom Agent', version: '1.0.0' },
          AgentPricing: data.isFree
            ? {
                pricingType: 'Free',
              }
            : {
                pricingType: 'Fixed',
                Pricing: data.prices.map((price) => ({
                  unit: price.unit === 'lovelace' ? 'lovelace' : getUsdmConfig(network).fullAssetId,
                  amount: (parseFloat(price.amount) * 1000000).toString(),
                })),
              },
          Author: {
            name: data.authorName || 'Setup User',
            contactEmail: data.authorEmail || '',
            organization: data.organization || '',
            contactOther: data.contactOther || '',
          },
          Legal: {
            terms: data.termsOfUseUrl || undefined,
            privacyPolicy: data.privacyPolicyUrl || undefined,
            other: data.otherUrl || undefined,
          },
          ExampleOutputs: [],
        },
      });

      if (registryResponse.error) {
        const error = registryResponse.error as { message: string };
        setError(error.message || 'Failed to register AI agent');
        return;
      }

      toast.success('AI agent registered successfully!');
      onAgentCreated?.();
      onNext();
    } catch (err) {
      setError('An unexpected error occurred');
      console.error('Error registering AI agent:', err);
    } finally {
      setIsLoading(false);
    }
  };

  const handleAddTag = () => {
    const tag = tagInput.trim();
    if (tag && !tags.includes(tag)) {
      setValue('tags', [...tags, tag]);
    }
    setTagInput('');
  };

  const handleRemoveTag = (tagToRemove: string) => {
    setValue(
      'tags',
      tags.filter((tag) => tag !== tagToRemove),
    );
  };

  return (
    <div className="space-y-6 max-w-[600px] w-full">
      <div className="text-center space-y-4">
        <h1 className="text-4xl font-bold">Add AI Agent</h1>
        <p className="text-sm text-muted-foreground">
          Create your first AI agent by providing its details below. This agent will be available
          for users to interact with and generate revenue through your payment system.
        </p>
      </div>

      <form onSubmit={handleSubmit(onSubmit)} className="space-y-6">
        {error && (
          <div className="p-3 text-sm text-red-600 bg-red-50 dark:bg-red-900/20 dark:text-red-400 rounded-md">
            {error}
          </div>
        )}

        <div className="space-y-2">
          <label className="text-sm font-medium">
            API URL <span className="text-red-500">*</span>
          </label>
          <Input
            {...register('apiUrl')}
            placeholder="https://your-agent-api.com"
            className={errors.apiUrl ? 'border-red-500' : ''}
          />
          {errors.apiUrl && <p className="text-sm text-red-500">{errors.apiUrl.message}</p>}
        </div>

        <div className="space-y-2">
          <label className="text-sm font-medium">
            Name <span className="text-red-500">*</span>
          </label>
          <Input
            {...register('name')}
            placeholder="Enter a name for your agent"
            className={errors.name ? 'border-red-500' : ''}
          />
          {errors.name && <p className="text-sm text-red-500">{errors.name.message}</p>}
        </div>

        <div className="space-y-2">
          <label className="text-sm font-medium">
            Description <span className="text-red-500">*</span>
          </label>
          <Textarea
            {...register('description')}
            placeholder="Describe what your agent does"
            className={`min-h-[100px] ${errors.description ? 'border-red-500' : ''}`}
          />
          {errors.description && (
            <p className="text-sm text-red-500">{errors.description.message}</p>
          )}
        </div>

        <div className="space-y-2">
          <label className="text-sm font-medium">Linked Wallet</label>
          <div className="rounded-lg border border-border p-4">
            <div className="flex items-center gap-2 mb-2">
              <span className="text-xs font-medium px-2 py-0.5 rounded-full bg-[#FFF7ED] text-[#C2410C] dark:bg-[#C2410C]/10 dark:text-[#FFF7ED]">
                Selling
              </span>
              <span className="text-sm font-medium">Selling wallet</span>
            </div>
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8"
                onClick={() => {
                  if (sellingWallet?.address) {
                    navigator.clipboard.writeText(sellingWallet.address);
                    toast.success('Copied to clipboard');
                  }
                }}
              >
                <Copy className="h-4 w-4" />
              </Button>
              {sellingWallet?.address ? (
                <a
                  href={getExplorerUrl(sellingWallet.address, network)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="font-mono text-sm break-all hover:underline text-primary"
                >
                  {shortenAddress(sellingWallet.address, 6)}
                </a>
              ) : (
                'No wallet available'
              )}
            </div>
          </div>
          <p className="text-sm text-muted-foreground">
            All payments for using this AI agent will be credited to this wallet
          </p>
        </div>

        <div className="space-y-2">
          <label className="text-sm font-medium">
            Pricing <span className="text-red-500">*</span>
          </label>
          <div className="space-y-3">
            {priceFields.map((field, index) => (
              <div key={field.id} className="flex gap-2">
                <div className="flex-1">
                  <Input
                    {...register(`prices.${index}.amount`)}
                    placeholder="0.00"
                    type="number"
                    step="0.01"
                    min="0"
                    className={errors.prices?.[index]?.amount ? 'border-red-500' : ''}
                  />
                </div>
                <Select
                  value={watch(`prices.${index}.unit`)}
                  onValueChange={(value) =>
                    setValue(`prices.${index}.unit`, value as 'lovelace' | 'USDM')
                  }
                >
                  <SelectTrigger className="w-24">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="lovelace">ADA</SelectItem>
                    <SelectItem value="USDM">USDM</SelectItem>
                  </SelectContent>
                </Select>
                {priceFields.length > 1 && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    onClick={() => removePrice(index)}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                )}
              </div>
            ))}
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => appendPrice({ unit: 'lovelace', amount: '' })}
            >
              Add Price
            </Button>
          </div>
          {errors.prices && <p className="text-sm text-red-500">{errors.prices.message}</p>}
        </div>

        <div className="space-y-2">
          <label className="text-sm font-medium">
            Tags <span className="text-red-500">*</span>
          </label>
          <div>
            <div className="flex gap-2">
              <Input
                placeholder="Add a tag"
                value={tagInput}
                onChange={(e) => setTagInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    handleAddTag();
                  }
                }}
                className={errors.tags ? 'border-red-500' : ''}
              />
              <Button type="button" variant="outline" onClick={handleAddTag}>
                Add
              </Button>
            </div>
            {errors.tags && <p className="text-sm text-red-500">{errors.tags.message}</p>}
            {tags.length > 0 && (
              <div className="flex flex-wrap gap-2 mt-2">
                {tags.map((tag: string) => (
                  <Badge
                    key={tag}
                    variant="secondary"
                    className="cursor-pointer"
                    onClick={() => handleRemoveTag(tag)}
                  >
                    {tag}
                  </Badge>
                ))}
              </div>
            )}
          </div>
        </div>

        <div className="flex items-center gap-4 pt-2">
          <Separator className="flex-1" />
          <h3 className="text-sm font-medium text-muted-foreground whitespace-nowrap">
            Additional Fields
          </h3>
          <Separator className="flex-1" />
        </div>

        <div className="space-y-2">
          <label className="text-sm font-medium">Author Name</label>
          <Input
            {...register('authorName')}
            placeholder="Enter the author's name"
            className={errors.authorName ? 'border-red-500' : ''}
          />
          {errors.authorName && <p className="text-sm text-red-500">{errors.authorName.message}</p>}
        </div>

        <div className="space-y-2">
          <label className="text-sm font-medium">Author Email</label>
          <Input
            {...register('authorEmail')}
            type="email"
            placeholder="Enter the author's email address"
            className={errors.authorEmail ? 'border-red-500' : ''}
          />
          {errors.authorEmail && (
            <p className="text-sm text-red-500">{errors.authorEmail.message}</p>
          )}
        </div>

        <div className="space-y-2">
          <label className="text-sm font-medium">Organization</label>
          <Input
            {...register('organization')}
            placeholder="Enter the organization name"
            className={errors.organization ? 'border-red-500' : ''}
          />
          {errors.organization && (
            <p className="text-sm text-red-500">{errors.organization.message}</p>
          )}
        </div>

        <div className="space-y-2">
          <label className="text-sm font-medium">Contact Other (Website, Phone...)</label>
          <Input
            {...register('contactOther')}
            placeholder="Enter other contact"
            className={errors.contactOther ? 'border-red-500' : ''}
          />
          {errors.contactOther && (
            <p className="text-sm text-red-500">{errors.contactOther.message}</p>
          )}
        </div>

        <div className="space-y-2">
          <label className="text-sm font-medium">Terms of Use URL</label>
          <Input
            {...register('termsOfUseUrl')}
            placeholder="Enter the terms of use URL"
            className={errors.termsOfUseUrl ? 'border-red-500' : ''}
          />
          {errors.termsOfUseUrl && (
            <p className="text-sm text-red-500">{errors.termsOfUseUrl.message}</p>
          )}
        </div>

        <div className="space-y-2">
          <label className="text-sm font-medium">Privacy Policy URL</label>
          <Input
            {...register('privacyPolicyUrl')}
            placeholder="Enter the privacy policy URL"
            className={errors.privacyPolicyUrl ? 'border-red-500' : ''}
          />
          {errors.privacyPolicyUrl && (
            <p className="text-sm text-red-500">{errors.privacyPolicyUrl.message}</p>
          )}
        </div>

        <div className="space-y-2">
          <label className="text-sm font-medium">Other URL (Support...)</label>
          <Input
            {...register('otherUrl')}
            placeholder="Enter the other URL"
            className={errors.otherUrl ? 'border-red-500' : ''}
          />
          {errors.otherUrl && <p className="text-sm text-red-500">{errors.otherUrl.message}</p>}
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div className="space-y-2">
            <label className="text-sm font-medium">Capability Name</label>
            <Input
              {...register('capabilityName')}
              placeholder="e.g., Text Generation"
              className={errors.capabilityName ? 'border-red-500' : ''}
            />
            {errors.capabilityName && (
              <p className="text-sm text-red-500">{errors.capabilityName.message}</p>
            )}
          </div>
          <div className="space-y-2">
            <label className="text-sm font-medium">Capability Version</label>
            <Input
              {...register('capabilityVersion')}
              placeholder="e.g., 1.0.0"
              className={errors.capabilityVersion ? 'border-red-500' : ''}
            />
            {errors.capabilityVersion && (
              <p className="text-sm text-red-500">{errors.capabilityVersion.message}</p>
            )}
          </div>
        </div>

        <div className="flex items-center justify-center gap-4 pt-4">
          <Button variant="secondary" className="text-sm" onClick={ignoreSetup}>
            Skip for now
          </Button>
          <Button type="submit" className="text-sm" disabled={isLoading}>
            {isLoading ? 'Adding...' : 'Add Agent'}
          </Button>
        </div>
      </form>
    </div>
  );
}
function SuccessScreen({
  onComplete,
  networkType,
  hasAiAgent = false,
}: {
  onComplete: () => void;
  networkType: string;
  hasAiAgent?: boolean;
}) {
  const networkDisplay = formatNetworkDisplay(networkType);

  return (
    <div className="text-center space-y-4 max-w-[600px]">
      <div className="flex justify-center mb-6">
        <span role="img" aria-label="celebration" className="text-4xl">
          🎉
        </span>
      </div>
      <h1 className="text-4xl font-bold">
        Your {networkDisplay} environment
        <br />
        is all set!
      </h1>

      <p className="text-sm text-muted-foreground mt-4 mb-8">
        You've successfully configured your payment environment and created secure wallets
        {hasAiAgent ? ' and set up your first AI agent' : ''}. You can now start managing your
        Agentic AI services and receiving payments through the dashboard.
      </p>

      <div className="flex items-center justify-center">
        <Button className="text-sm" onClick={onComplete}>
          Complete
        </Button>
      </div>
    </div>
  );
}

export function SetupWelcome({ networkType }: { networkType: string }) {
  const [currentStep, setCurrentStep] = useState(0);
  const [wallets, setWallets] = useState<{
    buying: { address: string; mnemonic: string } | null;
    selling: { address: string; mnemonic: string } | null;
  }>({
    buying: null,
    selling: null,
  });
  const [hasAiAgent, setHasAiAgent] = useState(false);
  const { setNetwork } = useAppContext();

  const handleComplete = () => {
    router.push('/');
  };

  const handleIgnoreSetup = () => {
    localStorage.setItem('userIgnoredSetup', 'true');
    router.push('/');
  };

  const handleCancel = () => {
    // Clear states
    setWallets({
      buying: null,
      selling: null,
    });
    // Return to welcome screen
    setCurrentStep(0);
  };

  const steps = [
    <WelcomeScreen
      key="welcome"
      onStart={() => setCurrentStep(1)}
      networkType={networkType}
      onNetworkChange={setNetwork}
    />,
    <SeedPhrasesScreen
      key="seed"
      onNext={(buying, selling) => {
        setWallets({ buying, selling });
        setCurrentStep(2);
      }}
      ignoreSetup={handleCancel}
    />,
    <PaymentSourceSetupScreen
      key="payment-source"
      onNext={() => setCurrentStep(3)}
      buyingWallet={wallets.buying}
      sellingWallet={wallets.selling}
      ignoreSetup={handleCancel}
    />,
    <AddAiAgentScreen
      key="ai"
      onNext={() => setCurrentStep(4)}
      sellingWallet={wallets.selling}
      ignoreSetup={handleIgnoreSetup}
      onAgentCreated={() => setHasAiAgent(true)}
    />,
    <SuccessScreen
      key="success"
      onComplete={handleComplete}
      networkType={networkType}
      hasAiAgent={hasAiAgent}
    />,
  ];

  return (
    <div className="w-full">
      <div className="flex items-center justify-center min-h-[calc(100vh-200px)] py-8">
        {steps[currentStep]}
      </div>
    </div>
  );
}
