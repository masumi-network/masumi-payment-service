import { Button } from '@/components/ui/button';
import { useState, useEffect } from 'react';
import { Checkbox } from '@/components/ui/checkbox';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Label } from '@/components/ui/label';
import { toast } from 'react-toastify';
import {
  Download,
  Copy,
  ArrowRight,
  Trash2,
  Wallet,
  Key,
  Bot,
  CheckCircle2,
  AlertTriangle,
  ChevronDown,
  ChevronUp,
  Info,
  ExternalLink,
  Sparkles,
  ShieldCheck,
  Check,
  Eye,
  EyeOff,
} from 'lucide-react';
import { useRouter } from 'next/router';
import { Spinner } from '@/components/ui/spinner';
import { useAppContext } from '@/lib/contexts/AppContext';
import { cn } from '@/lib/utils';
import {
  postWallet,
  postPaymentSourceExtended,
  postRegistry,
  getPaymentSourceExtended,
  getWalletList,
  type PaymentSourceExtended,
} from '@/lib/api/generated';
import { handleApiCall, shortenAddress } from '@/lib/utils';
import { WalletLink } from '@/components/ui/wallet-link';
import { usePaymentSourceExtendedAll } from '@/lib/hooks/usePaymentSourceExtendedAll';
import { DEFAULT_ADMIN_WALLETS } from '@/lib/constants/defaultWallets';
import { useForm, useFieldArray } from 'react-hook-form';
import { useQueryClient } from '@tanstack/react-query';
import { invalidateAgentQueries } from '@/lib/queries/agent-cache';
import { z } from 'zod';
import { zodResolver } from '@hookform/resolvers/zod';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Separator } from '@/components/ui/separator';
import {
  getActiveStablecoinConfig,
  getActiveStablecoinSymbol,
} from '@/lib/constants/defaultWallets';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { extractApiErrorMessage } from '@/lib/api-error';
import { REGISTRY_LIMITS } from '@/lib/registry-validation';
import { convertDecimalToBaseUnits } from '@/lib/convertDecimalToBaseUnits';
import { PaymentSourceTypeBadge } from '@/components/payment-sources/PaymentSourceTypeBadge';
import { DEFAULT_PAYMENT_SOURCE_TYPE, isV2PaymentSource } from '@/lib/payment-source-type';

function formatNetworkDisplay(networkType: string): string {
  return networkType?.toUpperCase() === 'MAINNET' ? 'Mainnet' : 'Preprod';
}

function copyToClipboard(text: string) {
  navigator.clipboard.writeText(text);
  toast.success('Copied to clipboard');
}

const STEP_LABELS = [
  'Welcome',
  'Seed phrases',
  'Payment source',
  'AI Agent (Optional)',
  'Complete',
];

function WelcomeScreen({ onStart, networkType }: { onStart: () => void; networkType: string }) {
  const networkDisplay = formatNetworkDisplay(networkType);

  const features = [
    { icon: Wallet, label: 'Create secure wallets' },
    { icon: Key, label: 'Configure V2 payment source' },
    { icon: Bot, label: 'Register your AI agent (optional)' },
  ];

  return (
    <Card className="w-full max-w-lg border shadow-xl bg-gradient-to-b from-card to-card/80 animate-scale-in-bounce">
      <CardHeader className="text-center pb-4 pt-8">
        <div className="mx-auto mb-6 relative">
          <div className="absolute inset-0 rounded-full bg-primary/20 blur-xl opacity-30" />
          <div className="relative flex h-16 w-16 items-center justify-center rounded-full bg-gradient-to-br from-primary/20 to-primary/5 ring-1 ring-primary/20">
            <Sparkles className="h-8 w-8 text-primary" />
          </div>
        </div>
        <CardTitle className="text-3xl font-bold animate-fade-in-up">Welcome!</CardTitle>
        <CardDescription className="text-base mt-2 animate-fade-in-up animate-delay-75">
          Let&apos;s set up your{' '}
          <Badge variant="outline" className="font-medium text-foreground mx-1">
            {networkDisplay}
          </Badge>{' '}
          environment
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6 pb-8">
        <div className="space-y-3">
          {features.map((feature, index) => (
            <div
              key={index}
              className={cn(
                'flex items-center gap-3 rounded-lg border bg-muted/30 px-4 py-3',
                'transition-colors duration-150 hover:bg-muted/50',
                'opacity-0 animate-slide-in-left',
                index === 0 && 'animate-delay-100',
                index === 1 && 'animate-delay-125',
                index === 2 && 'animate-delay-150',
              )}
              style={{ animationFillMode: 'forwards' }}
            >
              <div className="flex h-9 w-9 items-center justify-center rounded-full bg-primary/10">
                <feature.icon className="h-4 w-4 text-primary" />
              </div>
              <span className="text-sm font-medium">{feature.label}</span>
            </div>
          ))}
        </div>
        <div
          className="pt-2 opacity-0 animate-fade-in-up animate-delay-225"
          style={{ animationFillMode: 'forwards' }}
        >
          <Button
            onClick={onStart}
            className="w-full gap-2 h-11 text-base btn-hover-lift group"
            size="lg"
          >
            Get started{' '}
            <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-1" />
          </Button>
        </div>
      </CardContent>
    </Card>
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
  // Seed phrases are blurred by default. The user explicitly reveals to
  // copy/screenshot, which keeps mnemonics out of the DOM-visible tree
  // for casual screen-sharing / over-shoulder / screenshots taken while
  // navigating the rest of the wizard. Per-wallet flag because the user
  // may want to reveal one and not the other.
  const [showBuyingMnemonic, setShowBuyingMnemonic] = useState(false);
  const [showSellingMnemonic, setShowSellingMnemonic] = useState(false);
  const [error, setError] = useState<string>('');

  useEffect(() => {
    const generateWallets = async () => {
      setIsGenerating(true);
      setError('');

      // Type inferred from postWallet via handleApiCall's generic T.
      const buyingResponse = await handleApiCall(
        () =>
          postWallet({
            client: apiClient,
            body: {
              network: network,
            },
          }),
        {
          onError: (error: unknown) => {
            setError(extractApiErrorMessage(error, 'Failed to generate buying wallet'));
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

      // Type inferred from postWallet via handleApiCall's generic T.
      const sellingResponse = await handleApiCall(
        () =>
          postWallet({
            client: apiClient,
            body: {
              network: network,
            },
          }),
        {
          onError: (error: unknown) => {
            setError(extractApiErrorMessage(error, 'Failed to generate selling wallet'));
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
    <div className="space-y-6 w-full max-w-2xl">
      <div className="text-center space-y-3 animate-fade-in-up">
        <div className="inline-flex items-center justify-center rounded-full bg-gradient-to-br from-primary/20 to-primary/5 p-3 ring-1 ring-primary/20">
          <Wallet className="h-6 w-6 text-primary" />
        </div>
        <h1 className="text-2xl font-bold">Save your seed phrases</h1>
        <p className="text-sm text-muted-foreground max-w-md mx-auto">
          Store these phrases securely. You need them to access your wallets—we cannot recover them.
        </p>
      </div>

      {error && (
        <div className="flex items-center gap-3 rounded-lg border border-destructive/50 bg-destructive/10 px-4 py-3 text-sm text-destructive animate-fade-in-up">
          <AlertTriangle className="h-4 w-4 shrink-0" />
          {error}
        </div>
      )}

      <div
        className="rounded-xl border border-amber-500/30 bg-gradient-to-r from-amber-500/5 to-amber-500/10 px-4 py-4 flex gap-3 opacity-0 animate-slide-in-bottom animate-delay-75"
        style={{ animationFillMode: 'forwards' }}
      >
        <div className="flex h-8 w-8 items-center justify-center rounded-full bg-amber-500/20 shrink-0">
          <ShieldCheck className="h-4 w-4 text-amber-600 dark:text-amber-400" />
        </div>
        <div>
          <p className="text-sm font-medium text-amber-800 dark:text-amber-200">
            Security reminder
          </p>
          <p className="text-sm text-amber-700/80 dark:text-amber-300/80 mt-0.5">
            Never share seed phrases or store them online. Anyone with a phrase can control that
            wallet.
          </p>
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <Card
          className="overflow-hidden border-2 border-primary/10 bg-gradient-to-b from-primary/[0.02] to-transparent opacity-0 animate-slide-in-bottom animate-delay-100"
          style={{ animationFillMode: 'forwards' }}
        >
          <CardHeader className="pb-3 space-y-3">
            <div className="flex items-center justify-between">
              <Badge variant="secondary" className="gap-1.5 px-2.5">
                <Wallet className="h-3 w-3" /> Buying
              </Badge>
              {!isGenerating && buyingWallet && (
                <span className="text-xs text-green-600 dark:text-green-500 flex items-center gap-1 animate-pop-in">
                  <CheckCircle2 className="h-3 w-3" /> Generated
                </span>
              )}
            </div>
            <CardTitle className="text-base">Buying wallet</CardTitle>
            <CardDescription className="text-xs">
              Used to purchase AI agent services
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {isGenerating ? (
              <div className="flex flex-col items-center justify-center py-8 gap-3">
                <Spinner size={24} />
                <span className="text-sm text-muted-foreground animate-pulse">
                  Generating wallet...
                </span>
              </div>
            ) : (
              buyingWallet && (
                <div className="space-y-4">
                  <div className="flex items-center gap-2 rounded-lg bg-muted/50 px-3 py-2">
                    <span className="font-mono text-xs text-muted-foreground truncate flex-1">
                      {shortenAddress(buyingWallet.address, 12)}
                    </span>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7 shrink-0"
                      onClick={() => copyToClipboard(buyingWallet.address)}
                    >
                      <Copy className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                  <Separator />
                  <div className="space-y-3">
                    <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                      Seed phrase
                    </p>
                    <div className="relative rounded-lg bg-muted/30 p-3 border border-dashed">
                      <p
                        className={cn(
                          'font-mono text-xs text-foreground/80 break-all leading-relaxed transition-[filter] select-none',
                          !showBuyingMnemonic && 'blur-md',
                        )}
                        aria-hidden={!showBuyingMnemonic}
                      >
                        {buyingWallet.mnemonic}
                      </p>
                      {!showBuyingMnemonic && (
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          className="absolute inset-0 m-auto h-7 w-fit px-3 gap-1.5"
                          onClick={() => setShowBuyingMnemonic(true)}
                        >
                          <Eye className="h-3.5 w-3.5" /> Reveal seed phrase
                        </Button>
                      )}
                    </div>
                    <div className="flex gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        className="gap-1.5"
                        onClick={() => setShowBuyingMnemonic((v) => !v)}
                      >
                        {showBuyingMnemonic ? (
                          <>
                            <EyeOff className="h-3.5 w-3.5" /> Hide
                          </>
                        ) : (
                          <>
                            <Eye className="h-3.5 w-3.5" /> Show
                          </>
                        )}
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        className="gap-1.5 flex-1"
                        onClick={() => copyToClipboard(buyingWallet.mnemonic)}
                      >
                        <Copy className="h-3.5 w-3.5" /> Copy
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        className="gap-1.5 flex-1"
                        onClick={() => {
                          // Explicit consent before writing a plaintext
                          // seed phrase to disk — the file persists with
                          // no encryption and survives until the user
                          // shreds it.
                          const ok = window.confirm(
                            'This downloads your seed phrase as an unencrypted .txt file. Anyone with access to the file can spend your funds. Continue?',
                          );
                          if (!ok) return;
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
                        <Download className="h-3.5 w-3.5" /> Download
                      </Button>
                    </div>
                  </div>
                </div>
              )
            )}
          </CardContent>
        </Card>

        <Card
          className="overflow-hidden border-2 border-orange-500/20 bg-gradient-to-b from-orange-500/[0.03] to-transparent opacity-0 animate-slide-in-bottom animate-delay-125"
          style={{ animationFillMode: 'forwards' }}
        >
          <CardHeader className="pb-3 space-y-3">
            <div className="flex items-center justify-between">
              <Badge className="gap-1.5 px-2.5 bg-orange-600 hover:bg-orange-600">
                <Wallet className="h-3 w-3" /> Selling
              </Badge>
              {!isGenerating && sellingWallet && (
                <span className="text-xs text-green-600 dark:text-green-500 flex items-center gap-1 animate-pop-in">
                  <CheckCircle2 className="h-3 w-3" /> Generated
                </span>
              )}
            </div>
            <CardTitle className="text-base">Selling wallet</CardTitle>
            <CardDescription className="text-xs">
              Receives payments for your AI agents
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {isGenerating ? (
              <div className="flex flex-col items-center justify-center py-8 gap-3">
                <Spinner size={24} />
                <span className="text-sm text-muted-foreground animate-pulse">
                  Generating wallet...
                </span>
              </div>
            ) : (
              sellingWallet && (
                <div className="space-y-4">
                  <div className="flex items-center gap-2 rounded-lg bg-muted/50 px-3 py-2">
                    <span className="font-mono text-xs text-muted-foreground truncate flex-1">
                      {shortenAddress(sellingWallet.address, 12)}
                    </span>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7 shrink-0"
                      onClick={() => copyToClipboard(sellingWallet.address)}
                    >
                      <Copy className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                  <Separator />
                  <div className="space-y-3">
                    <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                      Seed phrase
                    </p>
                    <div className="relative rounded-lg bg-muted/30 p-3 border border-dashed">
                      <p
                        className={cn(
                          'font-mono text-xs text-foreground/80 break-all leading-relaxed transition-[filter] select-none',
                          !showSellingMnemonic && 'blur-md',
                        )}
                        aria-hidden={!showSellingMnemonic}
                      >
                        {sellingWallet.mnemonic}
                      </p>
                      {!showSellingMnemonic && (
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          className="absolute inset-0 m-auto h-7 w-fit px-3 gap-1.5"
                          onClick={() => setShowSellingMnemonic(true)}
                        >
                          <Eye className="h-3.5 w-3.5" /> Reveal seed phrase
                        </Button>
                      )}
                    </div>
                    <div className="flex gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        className="gap-1.5"
                        onClick={() => setShowSellingMnemonic((v) => !v)}
                      >
                        {showSellingMnemonic ? (
                          <>
                            <EyeOff className="h-3.5 w-3.5" /> Hide
                          </>
                        ) : (
                          <>
                            <Eye className="h-3.5 w-3.5" /> Show
                          </>
                        )}
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        className="gap-1.5 flex-1"
                        onClick={() => copyToClipboard(sellingWallet.mnemonic)}
                      >
                        <Copy className="h-3.5 w-3.5" /> Copy
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        className="gap-1.5 flex-1"
                        onClick={() => {
                          // Explicit consent before writing a plaintext
                          // seed phrase to disk — see buying-wallet block
                          // for full rationale.
                          const ok = window.confirm(
                            'This downloads your seed phrase as an unencrypted .txt file. Anyone with access to the file can spend your funds. Continue?',
                          );
                          if (!ok) return;
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
                        <Download className="h-3.5 w-3.5" /> Download
                      </Button>
                    </div>
                  </div>
                </div>
              )
            )}
          </CardContent>
        </Card>
      </div>

      <Card
        className="border-2 opacity-0 animate-slide-in-bottom animate-delay-175"
        style={{ animationFillMode: 'forwards' }}
      >
        <CardContent className="pt-6 pb-6">
          <div
            className={cn(
              'flex items-start gap-3 p-4 rounded-lg border transition-all duration-200',
              isConfirmed ? 'bg-green-500/5 border-green-500/30' : 'bg-muted/30 border-border',
            )}
          >
            <Checkbox
              id="confirm"
              checked={isConfirmed}
              onCheckedChange={(checked) => setIsConfirmed(checked as boolean)}
              disabled={isGenerating}
              className="mt-0.5"
            />
            <Label
              htmlFor="confirm"
              className="text-sm text-muted-foreground cursor-pointer leading-relaxed"
            >
              I have saved both seed phrases in a secure place and understand they cannot be
              recovered if lost.
            </Label>
          </div>
          <div className="flex flex-wrap items-center justify-center gap-3 pt-6">
            <Button variant="ghost" onClick={ignoreSetup} className="transition-all hover:bg-muted">
              Cancel
            </Button>
            <Button
              disabled={isGenerating || !isConfirmed || !buyingWallet || !sellingWallet}
              onClick={() => {
                if (buyingWallet && sellingWallet) {
                  onNext(buyingWallet, sellingWallet);
                }
              }}
              className="gap-2 min-w-[140px] btn-hover-lift group"
              size="lg"
            >
              {isGenerating ? (
                <>
                  <Spinner size={16} /> Generating...
                </>
              ) : (
                <>
                  Continue{' '}
                  <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-1" />
                </>
              )}
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

const paymentSourceSchema = z.object({
  blockfrostApiKey: z.string().min(1, 'Blockfrost API key is required'),
  requiredAdminSignatures: z.number().int().min(1).max(3),
});

type PaymentSourceFormValues = z.infer<typeof paymentSourceSchema>;

async function validateBlockfrostApiKey(
  apiKey: string,
  network: string,
): Promise<{ valid: boolean; error?: string }> {
  const baseUrl =
    network === 'Mainnet'
      ? 'https://cardano-mainnet.blockfrost.io/api/v0'
      : 'https://cardano-preprod.blockfrost.io/api/v0';

  try {
    const res = await fetch(`${baseUrl}/`, {
      headers: { project_id: apiKey },
    });

    if (res.status === 403 || res.status === 401) {
      // A 403 from the network-specific endpoint means the key is either
      // invalid or belongs to a different network (e.g. mainnet key on preprod endpoint).
      const expectedNetwork = network === 'Mainnet' ? 'Mainnet' : 'Preprod';
      return {
        valid: false,
        error: `Invalid Blockfrost API key. Please ensure the key is valid and belongs to the ${expectedNetwork} network.`,
      };
    }

    if (!res.ok) {
      return {
        valid: false,
        error: `Blockfrost returned an error (HTTP ${res.status}). Please verify your API key.`,
      };
    }

    // 200 from the network-specific endpoint confirms the key is valid for this network.
    return { valid: true };
  } catch {
    return {
      valid: false,
      error: 'Unable to reach Blockfrost. Please check your internet connection and try again.',
    };
  }
}

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
  const [customConfigOpen, setCustomConfigOpen] = useState(false);

  const adminWallets = DEFAULT_ADMIN_WALLETS[network];

  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<PaymentSourceFormValues>({
    resolver: zodResolver(paymentSourceSchema),
    defaultValues: {
      blockfrostApiKey: '',
      requiredAdminSignatures: 2,
    },
  });

  const onSubmit = async (data: PaymentSourceFormValues) => {
    if (!buyingWallet || !sellingWallet) {
      setError('Buying and selling wallets are required');
      return;
    }

    setIsLoading(true);
    setError('');

    // Validate Blockfrost API key before creating payment source
    const validation = await validateBlockfrostApiKey(data.blockfrostApiKey, network);
    if (!validation.valid) {
      const msg = validation.error ?? 'Invalid Blockfrost API key.';
      setError(msg);
      toast.error(msg);
      setIsLoading(false);
      return;
    }

    await handleApiCall(
      () =>
        postPaymentSourceExtended({
          client: apiClient,
          body: {
            network: network,
            paymentSourceType: DEFAULT_PAYMENT_SOURCE_TYPE,
            PaymentSourceConfig: {
              rpcProviderApiKey: data.blockfrostApiKey,
              rpcProvider: 'Blockfrost',
            },
            feeRatePermille: 0,
            AdminWallets: adminWallets.map((w) => ({
              walletAddress: w.walletAddress,
            })),
            requiredAdminSignatures: data.requiredAdminSignatures,
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
          toast.success('V2 payment source created successfully');
          onNext();
        },
        onError: (error: unknown) => {
          let msg = extractApiErrorMessage(error, 'Failed to create payment source');
          const normalizedMessage = msg.toLowerCase();

          // Check for Blockfrost-specific errors
          if (
            normalizedMessage.includes('invalid project token') ||
            normalizedMessage.includes('unauthorized') ||
            normalizedMessage.includes('403') ||
            normalizedMessage.includes('invalid api key')
          ) {
            msg = 'Invalid Blockfrost API key. Please check your key and try again.';
          } else if (
            normalizedMessage.includes('mainnet') ||
            normalizedMessage.includes('preprod') ||
            normalizedMessage.includes('testnet') ||
            normalizedMessage.includes('network mismatch') ||
            normalizedMessage.includes('wrong network')
          ) {
            const expectedNetwork = network === 'Mainnet' ? 'Mainnet' : 'Preprod';
            msg = `Your Blockfrost API key is for the wrong network. Please use a ${expectedNetwork} API key.`;
          } else if (
            normalizedMessage.includes('blockfrost') ||
            normalizedMessage.includes('rpc')
          ) {
            msg =
              'Unable to connect to Blockfrost. Please verify your API key is valid and for the correct network.';
          }

          setError(msg);
          toast.error(msg);
        },
        onFinally: () => {
          setIsLoading(false);
        },
        errorMessage: 'Failed to create payment source',
      },
    );
  };

  return (
    <div className="space-y-6 w-full max-w-2xl">
      <div className="text-center space-y-3 animate-fade-in-up">
        <div className="inline-flex items-center justify-center rounded-full bg-gradient-to-br from-primary/20 to-primary/5 p-3 ring-1 ring-primary/20">
          <Key className="h-6 w-6 text-primary" />
        </div>
        <div className="flex flex-wrap items-center justify-center gap-2">
          <h1 className="text-2xl font-bold">Configure payment source</h1>
          <PaymentSourceTypeBadge paymentSourceType={DEFAULT_PAYMENT_SOURCE_TYPE} showDefault />
        </div>
        <p className="text-sm text-muted-foreground max-w-md mx-auto">
          Connect to Blockfrost and create the V2 source. Your wallets from the previous step will
          be linked automatically.
        </p>
      </div>

      <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-950 dark:border-amber-900/50 dark:bg-amber-950/20 dark:text-amber-100">
        <div className="flex gap-3">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-300" />
          <p>
            V2 is now the default for new agents. If this network has older V1 agents, migrate them
            after V2 setup, then delete the old source once it is no longer used.
          </p>
        </div>
      </div>

      {error && (
        <div className="flex items-center gap-3 rounded-lg border border-destructive/50 bg-destructive/10 px-4 py-3 text-sm text-destructive animate-fade-in-up">
          <AlertTriangle className="h-4 w-4 shrink-0" />
          {error}
        </div>
      )}

      <form onSubmit={handleSubmit(onSubmit)} className="space-y-6">
        <Card
          className="border-2 opacity-0 animate-slide-in-bottom animate-delay-75"
          style={{ animationFillMode: 'forwards' }}
        >
          <CardHeader className="pb-4">
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10">
                <Key className="h-5 w-5 text-primary" />
              </div>
              <div>
                <CardTitle className="text-base">Blockfrost API key</CardTitle>
                <CardDescription className="mt-0.5">
                  Required to connect to the Cardano blockchain
                </CardDescription>
              </div>
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-3">
              <div className="flex items-center gap-2">
                <Label htmlFor="blockfrostApiKey" className="text-sm font-medium">
                  API key <span className="text-destructive">*</span>
                </Label>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span className="inline-flex text-muted-foreground hover:text-foreground cursor-help transition-colors">
                      <Info className="h-4 w-4" />
                    </span>
                  </TooltipTrigger>
                  <TooltipContent>
                    <p>Get a free API key at blockfrost.io</p>
                    <p className="text-xs text-muted-foreground mt-1">
                      Make sure to select the correct network (
                      {network === 'Mainnet' ? 'Mainnet' : 'Preprod'})
                    </p>
                  </TooltipContent>
                </Tooltip>
              </div>
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
                <Input
                  id="blockfrostApiKey"
                  type="text"
                  placeholder={`Enter your ${network === 'Mainnet' ? 'Mainnet' : 'Preprod'} API key`}
                  {...register('blockfrostApiKey')}
                  className={cn(
                    'sm:flex-1 transition-all focus:ring-2 focus:ring-primary/20',
                    errors.blockfrostApiKey && 'border-destructive',
                  )}
                />
                <a
                  href="https://blockfrost.io"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center justify-center gap-1.5 rounded-lg border bg-muted/30 px-4 py-2 text-sm font-medium text-primary hover:bg-muted/50 transition-all hover:translate-y-[-1px] group"
                >
                  Get API key{' '}
                  <ExternalLink className="h-3.5 w-3.5 transition-transform group-hover:translate-x-0.5" />
                </a>
              </div>
              <p className="text-xs text-muted-foreground">
                Your key must be for the{' '}
                <span className="font-medium text-foreground">
                  {network === 'Mainnet' ? 'Mainnet' : 'Preprod Testnet'}
                </span>{' '}
                network
              </p>
              {errors.blockfrostApiKey && (
                <p className="text-xs text-destructive animate-fade-in">
                  {errors.blockfrostApiKey.message}
                </p>
              )}
            </div>
          </CardContent>
        </Card>

        <Collapsible open={customConfigOpen} onOpenChange={setCustomConfigOpen}>
          <Card
            className="border-2 border-dashed opacity-0 animate-slide-in-bottom animate-delay-125"
            style={{ animationFillMode: 'forwards' }}
          >
            <CollapsibleTrigger asChild>
              <button
                type="button"
                className="flex w-full items-center justify-between px-6 py-4 text-left hover:bg-muted/30 transition-all"
              >
                <div className="flex items-center gap-3">
                  <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-muted">
                    <Info className="h-4 w-4 text-muted-foreground" />
                  </div>
                  <div>
                    <span className="text-sm font-medium">Advanced configuration</span>
                    <p className="text-xs text-muted-foreground">
                      V2 admin quorum and zero-fee setup
                    </p>
                  </div>
                </div>
                {customConfigOpen ? (
                  <ChevronUp className="h-4 w-4 text-muted-foreground" />
                ) : (
                  <ChevronDown className="h-4 w-4 text-muted-foreground" />
                )}
              </button>
            </CollapsibleTrigger>
            <CollapsibleContent>
              <div className="border-t px-6 pb-6 pt-4">
                <div className="space-y-4">
                  <div className="rounded-lg border bg-muted/30 px-4 py-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <PaymentSourceTypeBadge
                        paymentSourceType={DEFAULT_PAYMENT_SOURCE_TYPE}
                        showDefault
                      />
                      <p className="text-sm font-medium">Zero-fee V2 source</p>
                    </div>
                    <p className="mt-1 text-xs text-muted-foreground">
                      V2 sources always use 0% fees and do not require a fee receiver wallet.
                    </p>
                  </div>

                  <div className="space-y-3">
                    <Label className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                      Admin wallets
                    </Label>
                    <div className="space-y-2">
                      {adminWallets.map((wallet, index) => (
                        <div
                          key={index}
                          className="flex items-center justify-between rounded-lg border bg-muted/10 px-3 py-2.5"
                        >
                          <span className="text-xs font-medium text-muted-foreground">
                            Admin {index + 1}
                          </span>
                          <div className="flex items-center gap-1">
                            <span className="font-mono text-xs truncate max-w-[180px]">
                              {shortenAddress(wallet.walletAddress, 8)}
                            </span>
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon"
                              className="h-7 w-7"
                              onClick={() => copyToClipboard(wallet.walletAddress)}
                            >
                              <Copy className="h-3 w-3" />
                            </Button>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="requiredAdminSignatures" className="text-sm">
                      Required admin signatures <span className="text-destructive">*</span>
                    </Label>
                    <Input
                      id="requiredAdminSignatures"
                      type="number"
                      min={1}
                      max={3}
                      step={1}
                      {...register('requiredAdminSignatures', { valueAsNumber: true })}
                      className={cn(errors.requiredAdminSignatures && 'border-destructive')}
                    />
                    <p className="text-xs text-muted-foreground">
                      Default is 2 of 3 admin slots for V2 authorization.
                    </p>
                    {errors.requiredAdminSignatures && (
                      <p className="text-xs text-destructive">
                        {errors.requiredAdminSignatures.message}
                      </p>
                    )}
                  </div>
                </div>
              </div>
            </CollapsibleContent>
          </Card>
        </Collapsible>

        <Card
          className="border-2 opacity-0 animate-slide-in-bottom animate-delay-175"
          style={{ animationFillMode: 'forwards' }}
        >
          <CardContent className="py-6">
            <div className="flex flex-wrap items-center justify-center gap-3">
              <Button
                type="button"
                variant="ghost"
                onClick={ignoreSetup}
                className="transition-all hover:bg-muted"
              >
                Cancel
              </Button>
              <Button
                type="submit"
                disabled={isLoading}
                className="gap-2 min-w-[180px] btn-hover-lift group"
                size="lg"
              >
                {isLoading ? (
                  <>
                    <Spinner size={16} /> Creating...
                  </>
                ) : (
                  <>
                    Create payment source{' '}
                    <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-1" />
                  </>
                )}
              </Button>
            </div>
          </CardContent>
        </Card>
      </form>
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

  const stablecoinUnit = getActiveStablecoinSymbol(network);
  const priceSchema = z.object({
    unit: z.enum(['lovelace', stablecoinUnit] as const, {
      error: () => 'Token is required',
    }),
    amount: z
      .string()
      .max(REGISTRY_LIMITS.lovelaceAmount, 'Amount must be less than 25 characters')
      .refine((val) => {
        if (val === '0' || val === '0.0' || val === '0.00') return true;
        return !isNaN(parseFloat(val)) && parseFloat(val) >= 0;
      }, 'Amount must be a valid number >= 0'),
  });

  const agentSchema = z
    .object({
      apiUrl: z
        .string()
        .url('API URL must be a valid URL')
        .max(REGISTRY_LIMITS.apiBaseUrl, 'API URL must be less than 250 characters')
        .min(1, 'API URL is required')
        .refine((val) => val.startsWith('http://') || val.startsWith('https://'), {
          message: 'API URL must start with http:// or https://',
        }),
      name: z
        .string()
        .min(1, 'Name is required')
        .max(REGISTRY_LIMITS.agentName, 'Name must be less than 250 characters'),
      description: z
        .string()
        .min(1, 'Description is required')
        .max(REGISTRY_LIMITS.description, 'Description must be less than 250 characters'),
      prices: z
        .array(priceSchema)
        .max(REGISTRY_LIMITS.pricingOptionCount, 'You can add at most 5 prices'),
      tags: z
        .array(z.string().min(1).max(REGISTRY_LIMITS.tag, 'Tags must be less than 63 characters'))
        .min(1, 'At least one tag is required')
        .max(REGISTRY_LIMITS.tagCount, 'You can add at most 15 tags'),
      pricingType: z.enum(['Fixed', 'Free', 'Dynamic']),
      // Additional Fields
      authorName: z
        .string()
        .max(REGISTRY_LIMITS.authorName, 'Author name must be less than 250 characters')
        .optional()
        .or(z.literal('')),
      authorEmail: z
        .string()
        .email('Author email must be a valid email')
        .max(REGISTRY_LIMITS.authorContact, 'Author email must be less than 250 characters')
        .optional()
        .or(z.literal('')),
      organization: z
        .string()
        .max(REGISTRY_LIMITS.authorContact, 'Organization must be less than 250 characters')
        .optional()
        .or(z.literal('')),
      contactOther: z
        .string()
        .max(REGISTRY_LIMITS.authorContact, 'Contact other must be less than 250 characters')
        .optional()
        .or(z.literal('')),
      termsOfUseUrl: z
        .string()
        .url('Terms of use URL must be a valid URL')
        .max(REGISTRY_LIMITS.legalUrl, 'Terms of use URL must be less than 250 characters')
        .optional()
        .or(z.literal('')),
      privacyPolicyUrl: z
        .string()
        .url('Privacy policy URL must be a valid URL')
        .max(REGISTRY_LIMITS.legalUrl, 'Privacy policy URL must be less than 250 characters')
        .optional()
        .or(z.literal('')),
      otherUrl: z
        .string()
        .url('Other URL must be a valid URL')
        .max(REGISTRY_LIMITS.legalUrl, 'Other URL must be less than 250 characters')
        .optional()
        .or(z.literal('')),
      capabilityName: z
        .string()
        .max(REGISTRY_LIMITS.capabilityName, 'Capability name must be less than 250 characters')
        .optional()
        .or(z.literal('')),
      capabilityVersion: z
        .string()
        .max(
          REGISTRY_LIMITS.capabilityVersion,
          'Capability version must be less than 250 characters',
        )
        .optional()
        .or(z.literal('')),
    })
    .superRefine((data, ctx) => {
      if (data.pricingType === 'Fixed' && data.prices.length === 0) {
        ctx.addIssue({
          code: 'custom',
          path: ['prices'],
          message: 'At least one price is required for fixed pricing',
        });
      }
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
      pricingType: 'Fixed',
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
        setError(extractApiErrorMessage(response.error, 'Failed to fetch payment sources'));
        return;
      }

      const paymentSources = response.data?.data?.ExtendedPaymentSources ?? [];
      const filteredSources = paymentSources.filter(
        (source: PaymentSourceExtended) => source.network == network,
      );

      if (filteredSources.length === 0) {
        setError('No payment sources found for this network');
        return;
      }

      // Hot wallets are no longer embedded in the payment-source response; they
      // are served by the dedicated /wallet/list endpoint. Resolve the chosen
      // selling wallet's vKey via an exact address filter (not a capped scan, so
      // a wallet beyond the first page is still found), scoped to this network.
      const inNetworkSourceIds = new Set(filteredSources.map((source) => source.id));
      const walletsResponse = await getWalletList({
        client: apiClient,
        query: {
          walletType: 'Selling',
          walletAddress: sellingWallet.address,
        },
      });

      if (walletsResponse.error) {
        setError(extractApiErrorMessage(walletsResponse.error, 'Failed to fetch wallets'));
        return;
      }

      const sellingWalletData = (walletsResponse.data?.data?.Wallets ?? []).find((wallet) =>
        inNetworkSourceIds.has(wallet.paymentSourceId),
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
          AgentPricing: (() => {
            if (data.pricingType === 'Free') {
              return { pricingType: 'Free' as const };
            }
            if (data.pricingType === 'Dynamic') {
              return { pricingType: 'Dynamic' as const };
            }
            return {
              pricingType: 'Fixed' as const,
              Pricing: data.prices.map((price) => ({
                unit:
                  price.unit === 'lovelace'
                    ? 'lovelace'
                    : getActiveStablecoinConfig(network).fullAssetId,
                amount: convertDecimalToBaseUnits(price.amount),
              })),
            };
          })(),
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
        setError(extractApiErrorMessage(registryResponse.error, 'Failed to register AI agent'));
        return;
      }

      toast.success('AI agent registered successfully!');
      onAgentCreated?.();
      onNext();
    } catch (err) {
      setError(extractApiErrorMessage(err, 'An unexpected error occurred'));
      console.error('Error registering AI agent:', err);
    } finally {
      setIsLoading(false);
    }
  };

  const handleAddTag = () => {
    const tag = tagInput.trim();
    if (tags.length >= REGISTRY_LIMITS.tagCount) {
      return;
    }

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

  const [additionalFieldsOpen, setAdditionalFieldsOpen] = useState(false);

  return (
    <div className="space-y-6 w-full max-w-2xl">
      <div className="text-center space-y-3 animate-fade-in-up">
        <div className="inline-flex items-center justify-center rounded-full bg-gradient-to-br from-primary/20 to-primary/5 p-3 ring-1 ring-primary/20">
          <Bot className="h-6 w-6 text-primary" />
        </div>
        <h1 className="text-2xl font-bold">Register your AI agent</h1>
        <Badge variant="outline" className="mx-auto text-xs">
          Optional
        </Badge>
        <p className="text-sm text-muted-foreground max-w-md mx-auto">
          This step is optional. Add your first agent to the registry so users can discover and pay
          for it, or skip this and register agents later from the AI Agents page.
        </p>
      </div>

      <form onSubmit={handleSubmit(onSubmit)} className="space-y-6">
        {error && (
          <div className="flex items-center gap-3 rounded-lg border border-destructive/50 bg-destructive/10 px-4 py-3 text-sm text-destructive animate-fade-in-up">
            <AlertTriangle className="h-4 w-4 shrink-0" />
            {error}
          </div>
        )}

        <Card
          className="border-2 opacity-0 animate-slide-in-bottom animate-delay-75"
          style={{ animationFillMode: 'forwards' }}
        >
          <CardHeader className="pb-4">
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10">
                <Bot className="h-5 w-5 text-primary" />
              </div>
              <div>
                <CardTitle className="text-base">Agent details</CardTitle>
                <CardDescription className="mt-0.5">
                  Required information for the registry listing
                </CardDescription>
              </div>
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="apiUrl" className="text-sm">
                API URL <span className="text-destructive">*</span>
              </Label>
              <Input
                id="apiUrl"
                {...register('apiUrl')}
                placeholder="https://your-agent-api.com"
                className={errors.apiUrl ? 'border-destructive' : ''}
              />
              {errors.apiUrl && <p className="text-xs text-destructive">{errors.apiUrl.message}</p>}
            </div>
            <div className="space-y-2">
              <Label htmlFor="agentName" className="text-sm">
                Name <span className="text-destructive">*</span>
              </Label>
              <Input
                id="agentName"
                {...register('name')}
                placeholder="Enter a name for your agent"
                className={errors.name ? 'border-destructive' : ''}
              />
              {errors.name && <p className="text-xs text-destructive">{errors.name.message}</p>}
            </div>
            <div className="space-y-2">
              <Label htmlFor="description" className="text-sm">
                Description <span className="text-destructive">*</span>
              </Label>
              <Textarea
                id="description"
                {...register('description')}
                placeholder="Describe what your agent does and its key capabilities..."
                className={cn(
                  'min-h-[100px] resize-none',
                  errors.description && 'border-destructive',
                )}
              />
              <p className="text-xs text-muted-foreground">Max 250 characters</p>
              {errors.description && (
                <p className="text-xs text-destructive">{errors.description.message}</p>
              )}
            </div>
          </CardContent>
        </Card>

        <Card
          className="border-2 border-orange-500/20 bg-gradient-to-b from-orange-500/[0.02] to-transparent opacity-0 animate-slide-in-bottom animate-delay-100"
          style={{ animationFillMode: 'forwards' }}
        >
          <CardHeader className="pb-4">
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-orange-500/10">
                <Wallet className="h-5 w-5 text-orange-600" />
              </div>
              <div>
                <CardTitle className="text-base">Minting wallet</CardTitle>
                <CardDescription className="mt-0.5">
                  This selling wallet signs the mint transaction and pays the fees
                </CardDescription>
              </div>
            </div>
          </CardHeader>
          <CardContent>
            <div className="flex items-center justify-between rounded-lg border-2 border-orange-500/20 bg-orange-500/5 px-4 py-3 transition-all hover:bg-orange-500/10">
              <div className="flex items-center gap-3 min-w-0">
                <Badge className="shrink-0 bg-orange-600 hover:bg-orange-600 gap-1">
                  <Wallet className="h-3 w-3" /> Minting
                </Badge>
                {sellingWallet?.address ? (
                  <WalletLink address={sellingWallet.address} network={network} shorten={10} />
                ) : (
                  <span className="text-sm text-muted-foreground">No wallet</span>
                )}
              </div>
            </div>
          </CardContent>
        </Card>

        <Card
          className="border-2 opacity-0 animate-slide-in-bottom animate-delay-125"
          style={{ animationFillMode: 'forwards' }}
        >
          <CardHeader className="pb-4">
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10">
                <Key className="h-5 w-5 text-primary" />
              </div>
              <div>
                <CardTitle className="text-base">Pricing & tags</CardTitle>
                <CardDescription className="mt-0.5">
                  Set your pricing and add discovery tags
                </CardDescription>
              </div>
            </div>
          </CardHeader>
          <CardContent className="space-y-5">
            <div className="space-y-3">
              <Label className="text-sm">
                Pricing Type <span className="text-destructive">*</span>
              </Label>
              <Select
                value={watch('pricingType')}
                onValueChange={(val) => {
                  setValue('pricingType', val as 'Fixed' | 'Free' | 'Dynamic');
                  if (val !== 'Fixed') {
                    setValue('prices', [{ unit: 'lovelace', amount: '0.00' }]);
                  }
                }}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Select pricing type" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="Fixed">Fixed - Price per Agent</SelectItem>
                  <SelectItem value="Dynamic">Dynamic - Price set per payment</SelectItem>
                  <SelectItem value="Free">Free - No cost for interactions</SelectItem>
                </SelectContent>
              </Select>
              {watch('pricingType') === 'Dynamic' && (
                <p className="text-xs text-muted-foreground">
                  The price will be determined per payment/purchase request by the agent.
                </p>
              )}
            </div>
            <div className="space-y-3">
              <Label className="text-sm">
                Pricing <span className="text-destructive">*</span>
              </Label>
              <div className="space-y-3">
                {priceFields.map((field, index) => (
                  <div key={field.id} className="flex gap-2 items-center">
                    <Input
                      {...register(`prices.${index}.amount`)}
                      placeholder="0.00"
                      type="number"
                      step="0.01"
                      min={0}
                      disabled={watch('pricingType') !== 'Fixed'}
                      className={cn(
                        'flex-1',
                        errors.prices?.[index]?.amount && 'border-destructive',
                      )}
                    />
                    <Select
                      value={watch(`prices.${index}.unit`)}
                      disabled={watch('pricingType') !== 'Fixed'}
                      onValueChange={(value) =>
                        setValue(`prices.${index}.unit`, value as 'lovelace' | 'USDCx' | 'tUSDM')
                      }
                    >
                      <SelectTrigger className="w-28">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="lovelace">ADA</SelectItem>
                        <SelectItem value={stablecoinUnit}>{stablecoinUnit}</SelectItem>
                      </SelectContent>
                    </Select>
                    {priceFields.length > 1 && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="h-9 w-9 text-muted-foreground hover:text-destructive"
                        onClick={() => removePrice(index)}
                        aria-label="Remove price"
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
                  className="gap-1.5"
                  disabled={
                    watch('pricingType') !== 'Fixed' ||
                    priceFields.length >= REGISTRY_LIMITS.pricingOptionCount
                  }
                  onClick={() => appendPrice({ unit: 'lovelace', amount: '' })}
                >
                  <span className="text-lg leading-none">+</span> Add price option
                </Button>
              </div>
              {errors.prices && <p className="text-xs text-destructive">{errors.prices.message}</p>}
            </div>

            <Separator />

            <div className="space-y-3">
              <Label className="text-sm">
                Tags <span className="text-destructive">*</span>
              </Label>
              <div className="flex gap-2">
                <Input
                  placeholder="Type a tag and press Enter"
                  value={tagInput}
                  maxLength={REGISTRY_LIMITS.tag}
                  onChange={(e) => setTagInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      handleAddTag();
                    }
                  }}
                  className={errors.tags ? 'border-destructive' : ''}
                />
                <Button
                  type="button"
                  variant="outline"
                  disabled={tags.length >= REGISTRY_LIMITS.tagCount}
                  onClick={handleAddTag}
                >
                  Add
                </Button>
              </div>
              {tags.length > 0 && (
                <div className="flex flex-wrap gap-2 pt-1">
                  {tags.map((tag: string) => (
                    <Badge
                      key={tag}
                      variant="secondary"
                      className="cursor-pointer gap-1.5 pr-1.5 hover:bg-destructive/10 hover:text-destructive transition-colors"
                      onClick={() => handleRemoveTag(tag)}
                    >
                      {tag}
                      <span className="rounded-full bg-muted p-0.5">
                        <Trash2 className="h-2.5 w-2.5" />
                      </span>
                    </Badge>
                  ))}
                </div>
              )}
              <p className="text-xs text-muted-foreground">
                Add tags like &quot;AI&quot;, &quot;Text&quot;, &quot;Image&quot; to help users find
                your agent
              </p>
              {errors.tags && <p className="text-xs text-destructive">{errors.tags.message}</p>}
            </div>
          </CardContent>
        </Card>

        <Collapsible open={additionalFieldsOpen} onOpenChange={setAdditionalFieldsOpen}>
          <Card
            className="border-2 border-dashed opacity-0 animate-slide-in-bottom animate-delay-150"
            style={{ animationFillMode: 'forwards' }}
          >
            <CollapsibleTrigger asChild>
              <button
                type="button"
                className="flex w-full items-center justify-between px-6 py-4 text-left hover:bg-muted/30 transition-all group"
              >
                <div className="flex items-center gap-3">
                  <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-muted">
                    <Info className="h-4 w-4 text-muted-foreground" />
                  </div>
                  <div>
                    <span className="text-sm font-medium">Additional information</span>
                    <p className="text-xs text-muted-foreground">
                      Optional author, legal, and capability details
                    </p>
                  </div>
                </div>
                <div
                  className={cn(
                    'transition-transform duration-200',
                    additionalFieldsOpen && 'rotate-180',
                  )}
                >
                  <ChevronDown className="h-4 w-4 text-muted-foreground" />
                </div>
              </button>
            </CollapsibleTrigger>
            <CollapsibleContent>
              <div className="border-t px-6 pb-6 pt-4 space-y-5">
                <div>
                  <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground mb-3">
                    Author information
                  </p>
                  <div className="grid gap-4 sm:grid-cols-2">
                    <div className="space-y-2">
                      <Label htmlFor="authorName" className="text-sm">
                        Author name
                      </Label>
                      <Input
                        id="authorName"
                        {...register('authorName')}
                        placeholder="Your name"
                        className={errors.authorName ? 'border-destructive' : ''}
                      />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="authorEmail" className="text-sm">
                        Author email
                      </Label>
                      <Input
                        id="authorEmail"
                        {...register('authorEmail')}
                        type="email"
                        placeholder="you@example.com"
                        className={errors.authorEmail ? 'border-destructive' : ''}
                      />
                    </div>
                  </div>
                </div>

                <div className="grid gap-4 sm:grid-cols-2">
                  <div className="space-y-2">
                    <Label htmlFor="organization" className="text-sm">
                      Organization
                    </Label>
                    <Input
                      id="organization"
                      {...register('organization')}
                      placeholder="Company name"
                      className={errors.organization ? 'border-destructive' : ''}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="contactOther" className="text-sm">
                      Other contact
                    </Label>
                    <Input
                      id="contactOther"
                      {...register('contactOther')}
                      placeholder="Website, phone, etc."
                      className={errors.contactOther ? 'border-destructive' : ''}
                    />
                  </div>
                </div>

                <Separator />

                <div>
                  <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground mb-3">
                    Legal & documentation
                  </p>
                  <div className="space-y-4">
                    <div className="space-y-2">
                      <Label htmlFor="termsOfUseUrl" className="text-sm">
                        Terms of use URL
                      </Label>
                      <Input
                        id="termsOfUseUrl"
                        {...register('termsOfUseUrl')}
                        placeholder="https://..."
                        className={errors.termsOfUseUrl ? 'border-destructive' : ''}
                      />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="privacyPolicyUrl" className="text-sm">
                        Privacy policy URL
                      </Label>
                      <Input
                        id="privacyPolicyUrl"
                        {...register('privacyPolicyUrl')}
                        placeholder="https://..."
                        className={errors.privacyPolicyUrl ? 'border-destructive' : ''}
                      />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="otherUrl" className="text-sm">
                        Support URL
                      </Label>
                      <Input
                        id="otherUrl"
                        {...register('otherUrl')}
                        placeholder="https://..."
                        className={errors.otherUrl ? 'border-destructive' : ''}
                      />
                    </div>
                  </div>
                </div>

                <Separator />

                <div>
                  <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground mb-3">
                    Capability details
                  </p>
                  <div className="grid gap-4 sm:grid-cols-2">
                    <div className="space-y-2">
                      <Label htmlFor="capabilityName" className="text-sm">
                        Capability name
                      </Label>
                      <Input
                        id="capabilityName"
                        {...register('capabilityName')}
                        placeholder="e.g. Text Generation"
                        className={errors.capabilityName ? 'border-destructive' : ''}
                      />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="capabilityVersion" className="text-sm">
                        Version
                      </Label>
                      <Input
                        id="capabilityVersion"
                        {...register('capabilityVersion')}
                        placeholder="e.g. 1.0.0"
                        className={errors.capabilityVersion ? 'border-destructive' : ''}
                      />
                    </div>
                  </div>
                </div>
              </div>
            </CollapsibleContent>
          </Card>
        </Collapsible>

        <Card
          className="border-2 opacity-0 animate-slide-in-bottom animate-delay-175"
          style={{ animationFillMode: 'forwards' }}
        >
          <CardContent className="py-6">
            <div className="flex flex-wrap items-center justify-center gap-3">
              <Button
                type="button"
                variant="ghost"
                onClick={ignoreSetup}
                className="transition-all hover:bg-muted"
              >
                Skip for now
              </Button>
              <Button
                type="submit"
                disabled={isLoading}
                className="gap-2 min-w-[140px] btn-hover-lift group"
                size="lg"
              >
                {isLoading ? (
                  <>
                    <Spinner size={16} /> Registering...
                  </>
                ) : (
                  <>
                    Register agent{' '}
                    <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-1" />
                  </>
                )}
              </Button>
            </div>
          </CardContent>
        </Card>
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

  const completedItems = [
    { label: 'Wallets created and secured', icon: Wallet },
    { label: 'Payment source configured', icon: Key },
    ...(hasAiAgent ? [{ label: 'First AI agent registered', icon: Bot }] : []),
  ];

  return (
    <Card className="w-full max-w-lg border shadow-xl bg-gradient-to-b from-card to-card/80 overflow-hidden animate-scale-in-bounce">
      <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-green-500/50 to-transparent" />
      <CardHeader className="text-center pb-4 pt-10">
        <div className="mx-auto mb-6 relative animate-fade-in-up">
          <div className="absolute inset-0 rounded-full bg-green-500/10 blur-xl" />
          <div className="relative flex h-20 w-20 items-center justify-center rounded-full bg-gradient-to-br from-green-500/20 to-green-600/10 ring-2 ring-green-500/30">
            <CheckCircle2 className="h-10 w-10 text-green-600 dark:text-green-500" />
          </div>
        </div>
        <CardTitle
          className="text-3xl font-bold animate-fade-in-up animate-delay-75"
          style={{ animationFillMode: 'forwards' }}
        >
          You&apos;re all set!
        </CardTitle>
        <CardDescription
          className="text-base mt-2 opacity-0 animate-fade-in-up animate-delay-100"
          style={{ animationFillMode: 'forwards' }}
        >
          Your{' '}
          <Badge variant="outline" className="font-medium text-foreground mx-1">
            {networkDisplay}
          </Badge>{' '}
          environment is ready to use
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6 pb-8">
        <div className="space-y-3">
          {completedItems.map((item, index) => (
            <div
              key={index}
              className={cn(
                'flex items-center gap-3 rounded-lg border border-green-500/20 bg-green-500/5 px-4 py-3',
                'opacity-0 animate-slide-in-bottom',
                index === 0 && 'animate-delay-125',
                index === 1 && 'animate-delay-150',
                index === 2 && 'animate-delay-175',
              )}
              style={{ animationFillMode: 'forwards' }}
            >
              <div className="flex h-8 w-8 items-center justify-center rounded-full bg-green-500/10">
                <Check className="h-4 w-4 text-green-600 dark:text-green-500" />
              </div>
              <span className="text-sm font-medium">{item.label}</span>
            </div>
          ))}
        </div>

        <div
          className="rounded-lg border bg-muted/30 px-4 py-3 opacity-0 animate-fade-in animate-delay-225"
          style={{ animationFillMode: 'forwards' }}
        >
          <p className="text-sm text-muted-foreground text-center">
            Head to the dashboard to manage payment sources, agents, and transactions.
          </p>
        </div>

        <div
          className="pt-2 opacity-0 animate-fade-in-up animate-delay-275"
          style={{ animationFillMode: 'forwards' }}
        >
          <Button
            onClick={onComplete}
            className="w-full gap-2 h-11 text-base btn-hover-lift group"
            size="lg"
          >
            Go to dashboard{' '}
            <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-1" />
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

export function SetupWelcome({ networkType }: { networkType: string }) {
  const { setSetupWizardStep, setIsSetupMode } = useAppContext();
  const queryClient = useQueryClient();
  const router = useRouter();
  const [currentStep, setCurrentStep] = useState(0);
  const [wallets, setWallets] = useState<{
    buying: { address: string; mnemonic: string } | null;
    selling: { address: string; mnemonic: string } | null;
  }>({
    buying: null,
    selling: null,
  });
  const [hasAiAgent, setHasAiAgent] = useState(false);
  const { paymentSources } = usePaymentSourceExtendedAll();

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- Reset wizard state when network changes (user switched network during setup)
    setCurrentStep(0);
    setWallets({ buying: null, selling: null });
  }, [networkType]);

  // If the current network already has a V2 payment source and we're on the welcome step,
  // exit setup automatically. Legacy V1-only networks should still be able to migrate.
  useEffect(() => {
    const hasV2SourceForNetwork = paymentSources.some(
      (ps) => ps.network === networkType && isV2PaymentSource(ps),
    );
    if (currentStep === 0 && hasV2SourceForNetwork) {
      setIsSetupMode(false);
      router.push('/');
    }
  }, [networkType, paymentSources, currentStep, setIsSetupMode, router]);

  useEffect(() => {
    setSetupWizardStep(currentStep);
  }, [currentStep, setSetupWizardStep]);

  const exitSetup = (setIgnored = false) => {
    if (setIgnored) {
      localStorage.setItem('userIgnoredSetup', 'true');
    }
    setIsSetupMode(false);
    // Wallets, agents, transactions all keyed against the previous (often
    // empty) source set during setup. Invalidate the full set so the
    // dashboard the user lands on reflects what setup just created
    // (especially a step-3 AI agent that would otherwise be invisible
    // until the next refetch tick).
    queryClient.invalidateQueries({ queryKey: ['payment-sources-all'] });
    queryClient.invalidateQueries({ queryKey: ['payment-source-extended'] });
    queryClient.invalidateQueries({ queryKey: ['wallets'] });
    invalidateAgentQueries(queryClient);
    queryClient.invalidateQueries({ queryKey: ['transactions'] });
    router.push('/');
  };

  const handleCancel = () => {
    setWallets({ buying: null, selling: null });
    setCurrentStep(0);
  };

  const steps = [
    <WelcomeScreen key="welcome" onStart={() => setCurrentStep(1)} networkType={networkType} />,
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
      ignoreSetup={() => exitSetup(true)}
      onAgentCreated={() => setHasAiAgent(true)}
    />,
    <SuccessScreen
      key="success"
      onComplete={() => exitSetup()}
      networkType={networkType}
      hasAiAgent={hasAiAgent}
    />,
  ];

  const totalSteps = steps.length;
  const showStepper = currentStep > 0 && currentStep < totalSteps - 1;
  const stepperSteps = STEP_LABELS.slice(1, -1);

  return (
    <div className="w-full max-w-2xl mx-auto px-4">
      {showStepper && (
        <div className="mb-8 animate-fade-in">
          <div className="flex items-center justify-between mb-4">
            <div>
              <p className="text-sm font-medium">{STEP_LABELS[currentStep]}</p>
              <p className="text-xs text-muted-foreground">
                Step {currentStep} of {stepperSteps.length}
              </p>
            </div>
            <div className="flex items-center gap-2">
              {stepperSteps.map((label, i) => {
                const stepIndex = i + 1;
                const isComplete = currentStep > stepIndex;
                const isCurrent = currentStep === stepIndex;
                return (
                  <div key={stepIndex} className="flex items-center gap-2">
                    <div
                      className={cn(
                        'flex h-8 w-8 items-center justify-center rounded-full text-xs font-medium transition-all duration-300',
                        isComplete && 'bg-primary text-primary-foreground ring-2 ring-primary/20',
                        isCurrent &&
                          'bg-primary text-primary-foreground ring-4 ring-primary/20 scale-110',
                        !isComplete && !isCurrent && 'bg-muted text-muted-foreground',
                      )}
                      title={label}
                    >
                      {isComplete ? <Check className="h-4 w-4 animate-pop-in" /> : stepIndex}
                    </div>
                    {i < stepperSteps.length - 1 && (
                      <div
                        className={cn(
                          'h-0.5 w-6 rounded-full transition-all duration-500',
                          currentStep > stepIndex + 1 ? 'bg-primary' : 'bg-muted',
                        )}
                      />
                    )}
                  </div>
                );
              })}
            </div>
          </div>
          <div className="h-1 rounded-full bg-muted overflow-hidden">
            <div
              className="h-full bg-primary transition-all duration-500 ease-out"
              style={{ width: `${((currentStep - 1) / (stepperSteps.length - 1)) * 100}%` }}
            />
          </div>
        </div>
      )}
      <div className="flex flex-col items-center justify-center min-h-[calc(100vh-260px)] py-8">
        <div key={currentStep} className="animate-slide-in-right w-full">
          {steps[currentStep]}
        </div>
      </div>
    </div>
  );
}
