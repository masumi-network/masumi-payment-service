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
import { handleApiCall, shortenAddress } from '@/lib/utils';
import {
  DEFAULT_ADMIN_WALLETS,
  DEFAULT_FEE_CONFIG,
} from '@/lib/constants/defaultWallets';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { zodResolver } from '@hookform/resolvers/zod';

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
      setIsGenerating(true);
      setError('');

      const buyingResponse: any = await handleApiCall(
        () =>
          postWallet({
            client: apiClient,
            body: {
              network: state.network,
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
              network: state.network,
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

    await handleApiCall(
      () =>
        postPaymentSourceExtended({
          client: apiClient,
          body: {
            network: state.network,
            paymentType: 'Web3CardanoV1',
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

function AddAiAgentScreen({ onNext }: { onNext: () => void }) {
  const [tags, setTags] = useState<string[]>([]);
  const [newTag, setNewTag] = useState('');
  const [sellingWallet] = useState(
    '126f48bb1824c271b64c8716bc2478b1624c781266b4cb716b24c7216b',
  );

  const handleAddTag = () => {
    if (newTag && !tags.includes(newTag)) {
      setTags([...tags, newTag]);
      setNewTag('');
    }
  };

  const handleRemoveTag = (tagToRemove: string) => {
    setTags(tags.filter((tag) => tag !== tagToRemove));
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
        <button className="text-sm text-primary hover:underline">
          Learn more
        </button>
      </div>

      <div className="space-y-6">
        <div className="space-y-2">
          <label className="text-sm font-medium">API URL</label>
          <Input placeholder="Enter API URL" />
          <p className="text-sm text-muted-foreground">
            This is an input description.
          </p>
        </div>

        <div className="space-y-2">
          <label className="text-sm font-medium">Name</label>
          <Input placeholder="Enter name" />
        </div>

        <div className="space-y-2">
          <label className="text-sm font-medium">Description</label>
          <Textarea placeholder="Enter description" className="min-h-[100px]" />
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
              <Button variant="ghost" size="icon" className="h-8 w-8">
                <Copy className="h-4 w-4" />
              </Button>
              {sellingWallet}
            </div>
          </div>
          <p className="text-sm text-muted-foreground">
            All payments for using this AI agent will be credited to this wallet
          </p>
        </div>

        <div className="space-y-2">
          <label className="text-sm font-medium">Price, ADA</label>
          <Input type="number" placeholder="0.00" />
          <p className="text-sm text-muted-foreground">
            This is an input description.
          </p>
        </div>

        <div className="space-y-2">
          <label className="text-sm font-medium">Tags</label>
          <div className="flex flex-wrap gap-2">
            {tags.map((tag) => (
              <div
                key={tag}
                className="flex items-center gap-1 bg-secondary px-2 py-1 rounded-full"
              >
                <span className="text-sm">{tag}</span>
                <button onClick={() => handleRemoveTag(tag)}>
                  <X className="h-3 w-3" />
                </button>
              </div>
            ))}
            <div className="flex gap-2">
              <Input
                value={newTag}
                onChange={(e) => setNewTag(e.target.value)}
                onKeyPress={(e) => e.key === 'Enter' && handleAddTag()}
                placeholder="Add tag..."
                className="w-24"
              />
            </div>
          </div>
        </div>

        <div className="space-y-2">
          <label className="text-sm font-medium">Status</label>
          <Select defaultValue="active">
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="active">Active</SelectItem>
              <SelectItem value="inactive">Inactive</SelectItem>
            </SelectContent>
          </Select>
          <p className="text-sm text-muted-foreground">
            This is a select description.
          </p>
        </div>

        <div className="flex items-center justify-center gap-4 pt-4">
          <Button variant="secondary" className="text-sm">
            <Link href={'/'} replace>
              Skip for now
            </Link>
          </Button>
          <Button className="text-sm" onClick={onNext}>
            Add
          </Button>
        </div>
      </div>
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
    <AddAiAgentScreen key="ai" onNext={() => setCurrentStep(4)} />,
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
