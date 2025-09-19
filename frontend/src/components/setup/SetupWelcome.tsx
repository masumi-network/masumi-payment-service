/* eslint-disable @typescript-eslint/no-explicit-any */
/* eslint-disable react/no-unescaped-entities */

import { Button } from '@/components/ui/button';
import { Header } from '@/components/Header';
import { Footer } from '@/components/Footer';
import { useState, useEffect } from 'react';
import { Checkbox } from '@/components/ui/checkbox';
import { toast } from 'react-toastify';
import { Download, Copy, X } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import router from 'next/router';
import { Spinner } from '@/components/ui/spinner';
import Link from 'next/link';
import { useAppContext } from '@/lib/contexts/AppContext';
import { postWallet, postPaymentSourceExtended } from '@/lib/api/generated';
import { shortenAddress } from '@/lib/utils';
import {
  DEFAULT_ADMIN_WALLETS,
  DEFAULT_FEE_CONFIG,
} from '@/lib/constants/defaultWallets';
import { useForm, Controller, useFieldArray } from 'react-hook-form';
import { z } from 'zod';
import { zodResolver } from '@hookform/resolvers/zod';
import { postRegistry } from '@/lib/api/generated';
import { getUsdmConfig } from '@/lib/constants/defaultWallets';

function WelcomeScreen({
  onStart,
  networkType,
}: {
  onStart: () => void;
  networkType: string;
}) {
  const networkDisplay =
    networkType?.toUpperCase() === 'MAINNET' ? 'Mainnet' : 'Preprod';

  return (
    <div className="text-center space-y-4 max-w-[600px]">
      <h1 className="text-4xl font-bold">Welcome!</h1>
      <h2 className="text-3xl font-bold">
        Let&apos;s set up your
        <br />
        {networkDisplay} environment
      </h2>

      <p className="text-sm text-muted-foreground mt-4 mb-8 text-center max-w-md">
        We'll help you set up your payment environment by creating secure
        wallets, configuring payment sources, and setting up your first AI
        agent.
      </p>

      <div className="flex items-center justify-center gap-4 mt-8">
        <Button variant="secondary" className="text-sm">
          <Link href={'/'} replace>
            Skip for now
          </Link>
        </Button>
        <Button className="text-sm" onClick={onStart}>
          Start setup
        </Button>
      </div>
    </div>
  );
}

function SeedPhrasesScreen({
  onNext,
}: {
  onNext: (
    buyingWallet: { address: string; mnemonic: string },
    sellingWallet: { address: string; mnemonic: string },
  ) => void;
}) {
  const { apiClient, state } = useAppContext();
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
      try {
        setIsGenerating(true);
        setError('');

        const buyingResponse: any = await postWallet({
          client: apiClient,
          body: {
            network: state.network,
          },
        });

        if (
          !buyingResponse?.data?.data?.walletMnemonic ||
          !buyingResponse?.data?.data?.walletAddress
        ) {
          throw new Error('Failed to generate buying wallet');
        }

        setBuyingWallet({
          address: buyingResponse.data.data.walletAddress,
          mnemonic: buyingResponse.data.data.walletMnemonic,
        });

        const sellingResponse: any = await postWallet({
          client: apiClient,
          body: {
            network: state.network,
          },
        });

        if (
          !sellingResponse?.data?.data?.walletMnemonic ||
          !sellingResponse?.data?.data?.walletAddress
        ) {
          throw new Error('Failed to generate selling wallet');
        }

        setSellingWallet({
          address: sellingResponse.data.data.walletAddress,
          mnemonic: sellingResponse.data.data.walletMnemonic,
        });
      } catch (error) {
        console.error('Error generating wallets:', error);
        setError(
          error instanceof Error ? error.message : 'Failed to generate wallets',
        );
        toast.error('Failed to generate wallets');
      } finally {
        setIsGenerating(false);
      }
    };

    generateWallets();
  }, [apiClient, state.network]);

  return (
    <div className="space-y-6 max-w-[600px] w-full">
      <div className="text-center space-y-4">
        <h1 className="text-4xl font-bold">Save seed phrases</h1>
        <p className="text-sm text-muted-foreground">
          Please save these seed phrases securely. You will need them to access
          your wallets. These cannot be recovered if lost.
        </p>
      </div>

      {error && (
        <div className="text-sm text-destructive text-center">{error}</div>
      )}

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
                  {shortenAddress(buyingWallet.address)}
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
                  {shortenAddress(sellingWallet.address)}
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
          <Button variant="secondary" className="text-sm">
            <Link href={'/settings'} replace>
              Skip for now
            </Link>
          </Button>
          <Button
            className="text-sm"
            disabled={
              isGenerating || !isConfirmed || !buyingWallet || !sellingWallet
            }
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

const priceSchema = z.object({
  unit: z.enum(['lovelace', 'USDM', 'free'], {
    required_error: 'Token is required',
  }),
  amount: z.string().refine((val) => {
    if (val === 'free' || val === '0' || val === '0.0' || val === '0.00')
      return true;
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
});

type AgentFormValues = z.infer<typeof agentSchema>;

function PaymentSourceSetupScreen({
  onNext,
  buyingWallet,
  sellingWallet,
}: {
  onNext: () => void;
  buyingWallet: { address: string; mnemonic: string } | null;
  sellingWallet: { address: string; mnemonic: string } | null;
}) {
  const { apiClient, state } = useAppContext();
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string>('');

  const networkType = state.network === 'Mainnet' ? 'Mainnet' : 'Preprod';
  const adminWallets = DEFAULT_ADMIN_WALLETS[networkType];

  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<PaymentSourceFormValues>({
    resolver: zodResolver(paymentSourceSchema),
    defaultValues: {
      blockfrostApiKey: '',
      feeReceiverWallet: {
        walletAddress: DEFAULT_FEE_CONFIG[networkType].feeWalletAddress,
      },
      feePermille: DEFAULT_FEE_CONFIG[networkType].feePermille,
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

    try {
      setIsLoading(true);
      setError('');

      const response = await postPaymentSourceExtended({
        client: apiClient,
        body: {
          network: state.network,
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
      });

      if (response.status !== 200) {
        setError('Failed to create payment source');
        toast.error('Failed to create payment source');
        return;
      }

      toast.success('Payment source created successfully');
      onNext();
    } catch (error) {
      console.error('Error creating payment source:', error);
      setError(
        error instanceof Error
          ? error.message
          : 'Failed to create payment source',
      );
      toast.error('Failed to create payment source');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="space-y-6 max-w-[600px] w-full">
      <div className="text-center space-y-4">
        <h1 className="text-4xl font-bold">Setup Payment Source</h1>
        <p className="text-sm text-muted-foreground">
          Configure your payment source with the generated wallets.
        </p>
      </div>

      {error && (
        <div className="text-sm text-destructive text-center">{error}</div>
      )}

      <div className="space-y-6">
        {/* Admin Wallets Section */}
        <div className="space-y-4">
          <h3 className="text-lg font-semibold">Admin Wallets</h3>
          <div className="space-y-4">
            {adminWallets.map((wallet, index) => (
              <div
                key={index}
                className="rounded-lg border border-border p-4 space-y-4"
              >
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
                  {shortenAddress(wallet.walletAddress)}
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
                <p className="text-xs text-destructive mt-1">
                  {errors.blockfrostApiKey.message}
                </p>
              )}
            </div>

            <div className="space-y-2">
              <label className="text-sm font-medium">
                Fee Receiver Wallet Address{' '}
                <span className="text-destructive">*</span>
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
                <p className="text-xs text-destructive mt-1">
                  {errors.feePermille.message}
                </p>
              )}
            </div>

            <div className="flex items-center justify-center gap-4 pt-4">
              <Button variant="secondary" className="text-sm" type="button">
                <Link href={'/settings'} replace>
                  Skip for now
                </Link>
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
}: {
  onNext: () => void;
  sellingWallet: { address: string; mnemonic: string } | null;
}) {
  const { apiClient, state } = useAppContext();
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string>('');

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

  const handleCopy = (text: string) => {
    navigator.clipboard.writeText(text);
    toast.success('Copied to clipboard');
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

  const onSubmit = async (data: AgentFormValues) => {
    if (!sellingWallet) {
      setError('Selling wallet is required');
      return;
    }

    try {
      setIsLoading(true);
      setError('');

      const response = await postRegistry({
        client: apiClient,
        body: {
          network: state.network,
          sellingWalletVkey: sellingWallet.mnemonic,
          name: data.name,
          description: data.description,
          apiBaseUrl: data.apiUrl,
          Tags: data.tags,
          Capability: { name: 'Custom Agent', version: '1.0.0' },
          AgentPricing: (() => {
            const isFreeAgent = data.isFree;

            if (isFreeAgent) {
              return {
                pricingType: 'Free',
                Pricing: [],
              };
            }

            return {
              pricingType: 'Fixed',
              Pricing: data.prices.map((price) => {
                const unit =
                  price.unit === 'USDM'
                    ? getUsdmConfig(state.network).fullAssetId
                    : price.unit;
                return {
                  unit,
                  amount: (parseFloat(price.amount) * 1_000_000).toString(),
                };
              }),
            };
          })(),
          Author: { name: 'Setup Agent' },
          ExampleOutputs: [],
        },
      });

      if (!response.data?.data?.id) {
        throw new Error(
          'Failed to register AI agent: Invalid response from server',
        );
      }

      toast.success('AI agent registered successfully');
      onNext();
    } catch (error: any) {
      console.error('Error registering AI agent:', error);
      setError(error?.message ?? 'Failed to register AI agent');
      toast.error('Failed to register AI agent');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="space-y-6 max-w-[600px] w-full">
      <div className="text-center space-y-4">
        <h1 className="text-4xl font-bold">Add AI agent</h1>
        <p className="text-sm text-muted-foreground">
          Create your first AI agent by providing its details below. This agent
          will be available for users to interact with and generate revenue
          through your payment system.
        </p>
      </div>

      {error && (
        <div className="text-sm text-destructive text-center">{error}</div>
      )}

      <form onSubmit={handleSubmit(onSubmit)} className="space-y-6">
        <div className="space-y-2">
          <label className="text-sm font-medium">
            API URL <span className="text-red-500">*</span>
          </label>
          <Input
            {...register('apiUrl')}
            placeholder="Enter the API URL for your agent"
            className={errors.apiUrl ? 'border-red-500' : ''}
          />
          {errors.apiUrl && (
            <p className="text-sm text-red-500">{errors.apiUrl.message}</p>
          )}
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
          {errors.name && (
            <p className="text-sm text-red-500">{errors.name.message}</p>
          )}
        </div>

        <div className="space-y-2">
          <label className="text-sm font-medium">
            Description <span className="text-red-500">*</span>
          </label>
          <div className="relative">
            <Textarea
              {...register('description')}
              placeholder="Describe what your agent does"
              rows={3}
              className={errors.description ? 'border-red-500' : ''}
              maxLength={250}
            />
            <div className="absolute bottom-2 right-2 text-xs text-muted-foreground">
              {watch('description')?.length || 0}/250
            </div>
          </div>
          {errors.description && (
            <p className="text-sm text-red-500">{errors.description.message}</p>
          )}
        </div>

        <div className="space-y-2">
          <label className="text-sm font-medium">Linked wallet</label>
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
                type="button"
                onClick={() =>
                  sellingWallet && handleCopy(sellingWallet.address)
                }
              >
                <Copy className="h-4 w-4" />
              </Button>
              {sellingWallet
                ? shortenAddress(sellingWallet.address)
                : 'No wallet available'}
            </div>
          </div>
          <p className="text-sm text-muted-foreground">
            All payments for using this AI agent will be credited to this wallet
          </p>
        </div>

        {/* Free Agent Toggle */}
        <div className="space-y-4">
          <div className="flex items-center space-x-2">
            <Controller
              control={control}
              name="isFree"
              render={({ field }) => (
                <input
                  type="checkbox"
                  id="isFree"
                  checked={field.value || false}
                  onChange={(e) => {
                    field.onChange(e.target.checked);
                    if (e.target.checked) {
                      // Set to free pricing when checked
                      setValue('prices', [{ unit: 'free', amount: '0' }]);
                    } else {
                      // Reset to default pricing when unchecked
                      setValue('prices', [{ unit: 'lovelace', amount: '' }]);
                    }
                  }}
                  className="h-4 w-4 text-primary focus:ring-primary border-gray-300 rounded"
                />
              )}
            />
            <label htmlFor="isFree" className="text-sm font-medium">
              This is a free agent (no cost for interactions)
            </label>
          </div>
        </div>

        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <label className="text-sm font-medium">
              Prices <span className="text-red-500">*</span>
            </label>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={watch('isFree')}
              onClick={() => appendPrice({ unit: 'lovelace', amount: '' })}
            >
              Add Price
            </Button>
          </div>
          {priceFields.map((field, index) => (
            <div key={field.id} className="flex gap-2 items-start">
              <div className="flex-1 space-y-2">
                <Controller
                  control={control}
                  name={`prices.${index}.unit` as const}
                  render={({ field }) => (
                    <Select
                      value={field.value}
                      onValueChange={field.onChange}
                      disabled={watch('isFree')}
                    >
                      <SelectTrigger>
                        <SelectValue placeholder="Select token" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="lovelace">ADA</SelectItem>
                        <SelectItem value="USDM">USDM</SelectItem>
                        <SelectItem value="free">Free</SelectItem>
                      </SelectContent>
                    </Select>
                  )}
                />
              </div>
              <div className="flex-1 space-y-2">
                <Input
                  type="number"
                  placeholder={
                    watch(`prices.${index}.unit`) === 'free' ? '0' : '0.00'
                  }
                  disabled={watch(`prices.${index}.unit`) === 'free'}
                  value={
                    watch(`prices.${index}.unit`) === 'free'
                      ? '0'
                      : watch(`prices.${index}.amount`) || ''
                  }
                  {...register(`prices.${index}.amount` as const)}
                  min="0"
                  step="0.000001"
                />
                {errors.prices &&
                  Array.isArray(errors.prices) &&
                  errors.prices[index]?.amount && (
                    <p className="text-xs text-red-500">
                      {errors.prices[index]?.amount?.message}
                    </p>
                  )}
              </div>
              {index > 0 && (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  onClick={() => removePrice(index)}
                >
                  <X className="h-4 w-4" />
                </Button>
              )}
            </div>
          ))}
          {errors.prices && typeof errors.prices.message === 'string' && (
            <p className="text-sm text-red-500">{errors.prices.message}</p>
          )}
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
            {errors.tags && (
              <p className="text-sm text-red-500">{errors.tags.message}</p>
            )}
            {tags.length > 0 && (
              <div className="flex flex-wrap gap-2 mt-2">
                {tags.map((tag: string) => (
                  <div
                    key={tag}
                    className="flex items-center gap-1 bg-secondary px-2 py-1 rounded-full"
                  >
                    <span className="text-sm">{tag}</span>
                    <button type="button" onClick={() => handleRemoveTag(tag)}>
                      <X className="h-3 w-3" />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        <div className="flex items-center justify-center gap-4 pt-4">
          <Button variant="secondary" className="text-sm" type="button">
            <Link href={'/'} replace>
              Skip for now
            </Link>
          </Button>
          <Button
            className="text-sm"
            type="submit"
            disabled={isLoading || !sellingWallet}
          >
            {isLoading ? 'Registering...' : 'Register Agent'}
          </Button>
        </div>
      </form>
    </div>
  );
}

function SuccessScreen({
  onComplete,
  networkType,
}: {
  onComplete: () => void;
  networkType: string;
}) {
  return (
    <div className="text-center space-y-4 max-w-[600px]">
      <div className="flex justify-center mb-6">
        <span role="img" aria-label="celebration" className="text-4xl">
          🎉
        </span>
      </div>
      <h1 className="text-4xl font-bold">
        Your {networkType === 'mainnet' ? 'Mainnet' : 'Preprod'} environment
        <br />
        is all set!
      </h1>

      <p className="text-sm text-muted-foreground mt-4 mb-8">
        You've successfully configured your payment environment, created secure
        wallets, and set up your first AI agent. You can now start managing your
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

  const handleComplete = () => {
    router.push('/');
  };

  const steps = [
    <WelcomeScreen
      key="welcome"
      onStart={() => setCurrentStep(1)}
      networkType={networkType}
    />,
    <SeedPhrasesScreen
      key="seed"
      onNext={(buying, selling) => {
        setWallets({ buying, selling });
        setCurrentStep(2);
      }}
    />,
    <PaymentSourceSetupScreen
      key="payment-source"
      onNext={() => setCurrentStep(3)}
      buyingWallet={wallets.buying}
      sellingWallet={wallets.selling}
    />,
    <AddAiAgentScreen
      key="ai"
      onNext={() => setCurrentStep(4)}
      sellingWallet={wallets.selling}
    />,
    <SuccessScreen
      key="success"
      onComplete={handleComplete}
      networkType={networkType}
    />,
  ];

  return (
    <div className="min-h-screen flex flex-col w-full">
      <Header />
      <main className="flex-1 container w-full max-w-[1200px] mx-auto py-32 px-4">
        <div className="flex items-center justify-center min-h-[calc(100vh-200px)]">
          {steps[currentStep]}
        </div>
      </main>
      <Footer />
    </div>
  );
}
