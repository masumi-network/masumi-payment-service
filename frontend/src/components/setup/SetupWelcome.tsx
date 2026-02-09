import { Button } from '@/components/ui/button';
import { useState, useEffect } from 'react';
import { Checkbox } from '@/components/ui/checkbox';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { toast } from 'react-toastify';
import {
  Download,
  Copy,
  ArrowRight,
  Trash2,
  Wand2,
  Wallet,
  Key,
  Bot,
  CheckCircle2,
  AlertTriangle,
  ChevronDown,
  ChevronUp,
  Info,
  ExternalLink,
} from 'lucide-react';
import router from 'next/router';
import { Spinner } from '@/components/ui/spinner';
import { useAppContext } from '@/lib/contexts/AppContext';
import { cn } from '@/lib/utils';
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

function formatNetworkDisplay(networkType: string): string {
  return networkType?.toUpperCase() === 'MAINNET' ? 'Mainnet' : 'Preprod';
}

const STEP_LABELS = ['Welcome', 'Seed phrases', 'Payment source', 'AI Agent', 'Complete'];

function WelcomeScreen({ onStart, networkType }: { onStart: () => void; networkType: string }) {
  const networkDisplay = formatNetworkDisplay(networkType);

  return (
    <Card className="w-full max-w-lg border-0 shadow-lg bg-card/50">
      <CardHeader className="text-center pb-2">
        <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-primary/10">
          <Wand2 className="h-7 w-7 text-primary" />
        </div>
        <CardTitle className="text-2xl">Welcome!</CardTitle>
        <CardDescription className="text-base mt-1">
          Let&apos;s set up your{' '}
          <span className="font-medium text-foreground">{networkDisplay}</span> environment
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6 pt-2">
        <p className="text-sm text-muted-foreground text-center">
          We&apos;ll create secure wallets, configure a payment source, and optionally register your
          first AI agent.
        </p>
        <div className="flex flex-col sm:flex-row items-center justify-center gap-4">
          <div className="text-sm flex items-center gap-2">
            <span className="text-muted-foreground">Network:</span>
            <Badge variant="secondary" className="font-normal">
              {networkDisplay}
            </Badge>
          </div>
          <Button onClick={onStart} className="gap-2">
            Start setup <ArrowRight className="h-4 w-4" />
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
    <div className="space-y-6 w-full max-w-2xl">
      <div className="text-center space-y-2">
        <div className="inline-flex items-center justify-center rounded-full bg-primary/10 p-2 mb-2">
          <Wallet className="h-5 w-5 text-primary" />
        </div>
        <h1 className="text-2xl font-bold">Save seed phrases</h1>
        <p className="text-sm text-muted-foreground max-w-md mx-auto">
          Store these phrases securely. You need them to access your wallets—we cannot recover them.
        </p>
      </div>

      {error && (
        <div className="flex items-center gap-2 rounded-lg border border-destructive/50 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          <AlertTriangle className="h-4 w-4 shrink-0" />
          {error}
        </div>
      )}

      <div className="rounded-lg border border-amber-500/50 bg-amber-500/5 dark:bg-amber-500/10 px-4 py-3 flex gap-3">
        <AlertTriangle className="h-5 w-5 text-amber-600 dark:text-amber-500 shrink-0 mt-0.5" />
        <p className="text-sm text-amber-800 dark:text-amber-200">
          Never share seed phrases or store them online. Anyone with a phrase can control that
          wallet.
        </p>
      </div>

      <div className="grid gap-6 sm:grid-cols-2">
        <Card>
          <CardHeader className="pb-3">
            <Badge variant="secondary" className="w-fit">
              Buying
            </Badge>
            <CardTitle className="text-base mt-2">Buying wallet</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {isGenerating ? (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Spinner size={16} />
                Generating...
              </div>
            ) : (
              buyingWallet && (
                <div className="space-y-4">
                  <div className="flex items-center gap-2 text-sm">
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8 shrink-0"
                      onClick={() => handleCopy(buyingWallet.address)}
                    >
                      <Copy className="h-4 w-4" />
                    </Button>
                    <span className="font-mono text-muted-foreground truncate">
                      {shortenAddress(buyingWallet.address, 10)}
                    </span>
                  </div>
                  <Separator />
                  <div className="space-y-2">
                    <p className="text-sm font-medium">Seed phrase</p>
                    <p className="font-mono text-xs text-muted-foreground break-all">
                      {buyingWallet.mnemonic}
                    </p>
                    <div className="flex gap-2 pt-1">
                      <Button
                        variant="outline"
                        size="sm"
                        className="gap-1.5"
                        onClick={() => handleCopy(buyingWallet.mnemonic)}
                      >
                        <Copy className="h-3.5 w-3.5" /> Copy
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        className="gap-1.5"
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
                        <Download className="h-3.5 w-3.5" /> Download
                      </Button>
                    </div>
                  </div>
                </div>
              )
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <Badge className="w-fit bg-orange-600 hover:bg-orange-700">Selling</Badge>
            <CardTitle className="text-base mt-2">Selling wallet</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {isGenerating ? (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Spinner size={16} />
                Generating...
              </div>
            ) : (
              sellingWallet && (
                <div className="space-y-4">
                  <div className="flex items-center gap-2 text-sm">
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8 shrink-0"
                      onClick={() => handleCopy(sellingWallet.address)}
                    >
                      <Copy className="h-4 w-4" />
                    </Button>
                    <span className="font-mono text-muted-foreground truncate">
                      {shortenAddress(sellingWallet.address, 10)}
                    </span>
                  </div>
                  <Separator />
                  <div className="space-y-2">
                    <p className="text-sm font-medium">Seed phrase</p>
                    <p className="font-mono text-xs text-muted-foreground break-all">
                      {sellingWallet.mnemonic}
                    </p>
                    <div className="flex gap-2 pt-1">
                      <Button
                        variant="outline"
                        size="sm"
                        className="gap-1.5"
                        onClick={() => handleCopy(sellingWallet.mnemonic)}
                      >
                        <Copy className="h-3.5 w-3.5" /> Copy
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        className="gap-1.5"
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

      <Card>
        <CardContent className="pt-6">
          <div className="flex items-start gap-3">
            <Checkbox
              id="confirm"
              checked={isConfirmed}
              onCheckedChange={(checked) => setIsConfirmed(checked as boolean)}
              disabled={isGenerating}
              className="mt-0.5"
            />
            <Label
              htmlFor="confirm"
              className="text-sm text-muted-foreground cursor-pointer leading-tight"
            >
              I have saved both seed phrases in a secure place and understand they cannot be
              recovered if lost.
            </Label>
          </div>
          <div className="flex flex-wrap items-center justify-center gap-3 pt-6">
            <Button variant="outline" onClick={ignoreSetup}>
              Cancel
            </Button>
            <Button
              disabled={isGenerating || !isConfirmed || !buyingWallet || !sellingWallet}
              onClick={() => {
                if (buyingWallet && sellingWallet) {
                  onNext(buyingWallet, sellingWallet);
                }
              }}
              className="gap-2"
            >
              {isGenerating ? 'Generating...' : 'Continue'} <ArrowRight className="h-4 w-4" />
            </Button>
          </div>
        </CardContent>
      </Card>
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
  const [customSetup, setCustomSetup] = useState(false);
  const [showCustomSetupDialog, setShowCustomSetupDialog] = useState(false);
  const [feePercentInput, setFeePercentInput] = useState('');
  const [customConfigOpen, setCustomConfigOpen] = useState(false);

  const adminWallets = DEFAULT_ADMIN_WALLETS[network];
  const defaultFeeConfig = DEFAULT_FEE_CONFIG[network];

  const {
    register,
    handleSubmit,
    setValue,
    watch,
    formState: { errors },
  } = useForm<PaymentSourceFormValues>({
    resolver: zodResolver(paymentSourceSchema),
    defaultValues: {
      blockfrostApiKey: '',
      feeReceiverWallet: {
        walletAddress: defaultFeeConfig.feeWalletAddress,
      },
      feePermille: defaultFeeConfig.feePermille,
    },
  });

  const handleCopy = (text: string) => {
    navigator.clipboard.writeText(text);
    toast.success('Copied to clipboard');
  };

  const handleCustomSetupChecked = (checked: boolean | 'indeterminate') => {
    if (checked === true) {
      setShowCustomSetupDialog(true);
    } else {
      setCustomSetup(false);
      setValue('feeReceiverWallet.walletAddress', defaultFeeConfig.feeWalletAddress);
      setValue('feePermille', defaultFeeConfig.feePermille);
    }
  };

  const handleConfirmCustomSetup = () => {
    setCustomSetup(true);
    setShowCustomSetupDialog(false);
    setFeePercentInput((defaultFeeConfig.feePermille / 10).toFixed(1));
  };

  const onSubmit = async (data: PaymentSourceFormValues) => {
    if (!buyingWallet || !sellingWallet) {
      setError('Buying and selling wallets are required');
      return;
    }

    setIsLoading(true);
    setError('');

    const feeReceiverWallet = customSetup
      ? data.feeReceiverWallet
      : { walletAddress: defaultFeeConfig.feeWalletAddress };
    const feePermille = customSetup ? data.feePermille : defaultFeeConfig.feePermille;

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
            feeRatePermille: feePermille,
            AdminWallets: adminWallets.map((w) => ({
              walletAddress: w.walletAddress,
            })) as [
              { walletAddress: string },
              { walletAddress: string },
              { walletAddress: string },
            ],
            FeeReceiverNetworkWallet: feeReceiverWallet,
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
        onError: (error: unknown) => {
          const msg =
            error && typeof error === 'object' && 'message' in error
              ? String((error as { message: string }).message)
              : 'Failed to create payment source';
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
      <div className="text-center space-y-2">
        <div className="inline-flex items-center justify-center rounded-full bg-primary/10 p-2 mb-2">
          <Key className="h-5 w-5 text-primary" />
        </div>
        <h1 className="text-2xl font-bold">Payment source</h1>
        <p className="text-sm text-muted-foreground">
          Configure Blockfrost and fee settings. Wallets from the previous step will be linked.
        </p>
      </div>

      {error && (
        <div className="flex items-center gap-2 rounded-lg border border-destructive/50 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          <AlertTriangle className="h-4 w-4 shrink-0" />
          {error}
        </div>
      )}

      <Dialog open={showCustomSetupDialog} onOpenChange={setShowCustomSetupDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Custom network setup</DialogTitle>
          </DialogHeader>
          <div className="py-2">
            <p className="text-sm text-muted-foreground">
              A custom network setup is required. There may not be registered agents on other
              contracts, and customer support is limited. Only enable this if you need to use
              different fee or admin settings.
            </p>
          </div>
          <DialogFooter className="gap-2 sm:gap-0">
            <Button variant="outline" onClick={() => setShowCustomSetupDialog(false)}>
              Cancel
            </Button>
            <Button onClick={handleConfirmCustomSetup}>I understand, enable custom setup</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <form onSubmit={handleSubmit(onSubmit)} className="space-y-6">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Blockfrost API key</CardTitle>
            <CardDescription>
              Provide your Blockfrost API key to connect to the Cardano blockchain.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <Label htmlFor="blockfrostApiKey">
                  Blockfrost API key <span className="text-destructive">*</span>
                </Label>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span className="inline-flex text-muted-foreground hover:text-foreground">
                      <Info className="h-4 w-4" />
                    </span>
                  </TooltipTrigger>
                  <TooltipContent>You can sign up for free at Blockfrost.</TooltipContent>
                </Tooltip>
              </div>
              <div className="flex flex-col gap-1.5 sm:flex-row sm:items-center sm:gap-2">
                <Input
                  id="blockfrostApiKey"
                  type="text"
                  placeholder="Enter your Blockfrost API key"
                  {...register('blockfrostApiKey')}
                  className={cn('sm:max-w-sm', errors.blockfrostApiKey && 'border-destructive')}
                />
                <a
                  href="https://blockfrost.io"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1.5 text-sm text-primary hover:underline"
                >
                  blockfrost.io <ExternalLink className="h-3.5 w-3.5" />
                </a>
              </div>
              {errors.blockfrostApiKey && (
                <p className="text-xs text-destructive">{errors.blockfrostApiKey.message}</p>
              )}
            </div>
          </CardContent>
        </Card>

        <div className="rounded-lg border">
          <Button
            type="button"
            variant="ghost"
            className="w-full justify-between rounded-b-none px-4 py-3 hover:bg-muted/50"
            onClick={() => setCustomConfigOpen((o) => !o)}
          >
            <span className="font-medium">Custom configuration</span>
            {customConfigOpen ? (
              <ChevronUp className="h-4 w-4 text-muted-foreground" />
            ) : (
              <ChevronDown className="h-4 w-4 text-muted-foreground" />
            )}
          </Button>
          {customConfigOpen && (
            <div className="border-t px-4 pb-4 pt-2">
              <Card className={cn('border-0 shadow-none', !customSetup && 'opacity-90')}>
                <CardHeader className="space-y-2">
                  <div className="flex items-center justify-between gap-4">
                    <div>
                      <CardTitle className="text-base">Fee & admin wallets</CardTitle>
                      <CardDescription>
                        Default fee receiver and admin addresses. Enable custom setup to change
                        them.
                      </CardDescription>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <Checkbox
                        id="customSetup"
                        checked={customSetup}
                        onCheckedChange={handleCustomSetupChecked}
                      />
                      <Label htmlFor="customSetup" className="text-sm font-medium cursor-pointer">
                        Custom setup
                      </Label>
                    </div>
                  </div>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="space-y-2">
                    <Label className="text-xs font-medium text-muted-foreground">
                      Admin wallets
                    </Label>
                    <div className="space-y-2">
                      {adminWallets.map((wallet, index) => (
                        <div
                          key={index}
                          className={cn(
                            'flex items-center justify-between rounded-lg border px-3 py-2',
                            customSetup ? 'bg-muted/30' : 'bg-muted/20 opacity-80',
                          )}
                        >
                          <span className="text-xs font-medium text-muted-foreground">
                            Admin wallet {index + 1}
                          </span>
                          <div className="flex items-center gap-1">
                            <span className="font-mono text-sm truncate max-w-[180px]">
                              {shortenAddress(wallet.walletAddress, 8)}
                            </span>
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon"
                              className="h-7 w-7"
                              onClick={() => handleCopy(wallet.walletAddress)}
                              disabled={!customSetup}
                            >
                              <Copy className="h-3.5 w-3.5" />
                            </Button>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="feeReceiverWallet">
                      Fee receiver wallet address <span className="text-destructive">*</span>
                    </Label>
                    <Input
                      id="feeReceiverWallet"
                      type="text"
                      placeholder="Enter fee receiver wallet address"
                      {...register('feeReceiverWallet.walletAddress')}
                      disabled={!customSetup}
                      className={cn(
                        errors.feeReceiverWallet?.walletAddress && 'border-destructive',
                        !customSetup && 'cursor-not-allowed opacity-70',
                      )}
                    />
                    {errors.feeReceiverWallet?.walletAddress && (
                      <p className="text-xs text-destructive">
                        {errors.feeReceiverWallet.walletAddress.message}
                      </p>
                    )}
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="feePermille">
                      Fee (%) <span className="text-destructive">*</span>
                    </Label>
                    <Input
                      id="feePermille"
                      type="number"
                      min={0}
                      max={100}
                      step={0.1}
                      value={
                        customSetup
                          ? feePercentInput
                          : (defaultFeeConfig.feePermille / 10).toFixed(1)
                      }
                      onChange={(e) => setFeePercentInput(e.target.value)}
                      onBlur={() => {
                        const percent = parseFloat(feePercentInput);
                        if (!Number.isNaN(percent)) {
                          const permille = Math.round(Math.min(100, Math.max(0, percent)) * 10);
                          setValue('feePermille', permille, { shouldValidate: true });
                          setFeePercentInput((permille / 10).toFixed(1));
                        } else {
                          setFeePercentInput((watch('feePermille') / 10).toFixed(1));
                        }
                      }}
                      disabled={!customSetup}
                      className={cn(
                        errors.feePermille && 'border-destructive',
                        !customSetup && 'cursor-not-allowed opacity-70',
                      )}
                    />
                    <p className="text-xs text-muted-foreground">0–100%, one decimal.</p>
                    {errors.feePermille && (
                      <p className="text-xs text-destructive">{errors.feePermille.message}</p>
                    )}
                  </div>
                </CardContent>
              </Card>
            </div>
          )}
        </div>

        <div className="flex flex-wrap items-center justify-center gap-3">
          <Button type="button" variant="outline" onClick={ignoreSetup}>
            Cancel
          </Button>
          <Button type="submit" disabled={isLoading} className="gap-2">
            {isLoading ? 'Creating...' : 'Create payment source'} <ArrowRight className="h-4 w-4" />
          </Button>
        </div>
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
    <div className="space-y-6 w-full max-w-2xl">
      <div className="text-center space-y-2">
        <div className="inline-flex items-center justify-center rounded-full bg-primary/10 p-2 mb-2">
          <Bot className="h-5 w-5 text-primary" />
        </div>
        <h1 className="text-2xl font-bold">Add AI agent</h1>
        <p className="text-sm text-muted-foreground max-w-md mx-auto">
          Register your first agent so users can discover it and pay for usage. You can skip and add
          one later.
        </p>
      </div>

      <form onSubmit={handleSubmit(onSubmit)} className="space-y-6">
        {error && (
          <div className="flex items-center gap-2 rounded-lg border border-destructive/50 bg-destructive/10 px-4 py-3 text-sm text-destructive">
            <AlertTriangle className="h-4 w-4 shrink-0" />
            {error}
          </div>
        )}

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Agent details</CardTitle>
            <CardDescription>Required fields for registry listing.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="apiUrl">
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
              <Label htmlFor="agentName">
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
              <Label htmlFor="description">
                Description <span className="text-destructive">*</span>
              </Label>
              <Textarea
                id="description"
                {...register('description')}
                placeholder="Describe what your agent does"
                className={cn('min-h-[100px]', errors.description && 'border-destructive')}
              />
              {errors.description && (
                <p className="text-xs text-destructive">{errors.description.message}</p>
              )}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Linked wallet</CardTitle>
            <CardDescription>
              Payments for this agent will be sent to this selling wallet.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="flex items-center justify-between rounded-lg border bg-muted/30 px-3 py-2">
              <div className="flex items-center gap-2 min-w-0">
                <Badge className="shrink-0 bg-orange-600 hover:bg-orange-700">Selling</Badge>
                {sellingWallet?.address ? (
                  <a
                    href={getExplorerUrl(sellingWallet.address, network)}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="font-mono text-sm truncate hover:underline text-primary"
                  >
                    {shortenAddress(sellingWallet.address, 8)}
                  </a>
                ) : (
                  <span className="text-sm text-muted-foreground">No wallet</span>
                )}
              </div>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="h-7 w-7 shrink-0"
                onClick={() => {
                  if (sellingWallet?.address) {
                    navigator.clipboard.writeText(sellingWallet.address);
                    toast.success('Copied to clipboard');
                  }
                }}
              >
                <Copy className="h-3.5 w-3.5" />
              </Button>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Pricing & tags</CardTitle>
            <CardDescription>At least one price and one tag are required.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label>Pricing</Label>
              <div className="space-y-3">
                {priceFields.map((field, index) => (
                  <div key={field.id} className="flex gap-2 items-center">
                    <Input
                      {...register(`prices.${index}.amount`)}
                      placeholder="0.00"
                      type="number"
                      step="0.01"
                      min={0}
                      className={cn(
                        'flex-1',
                        errors.prices?.[index]?.amount && 'border-destructive',
                      )}
                    />
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
                  onClick={() => appendPrice({ unit: 'lovelace', amount: '' })}
                >
                  Add price
                </Button>
              </div>
              {errors.prices && <p className="text-xs text-destructive">{errors.prices.message}</p>}
            </div>
            <div className="space-y-2">
              <Label>Tags</Label>
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
                  className={errors.tags ? 'border-destructive' : ''}
                />
                <Button type="button" variant="outline" onClick={handleAddTag}>
                  Add
                </Button>
              </div>
              {tags.length > 0 && (
                <div className="flex flex-wrap gap-2">
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
              {errors.tags && <p className="text-xs text-destructive">{errors.tags.message}</p>}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Additional fields</CardTitle>
            <CardDescription>Optional author, legal, and capability info.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="authorName">Author name</Label>
                <Input
                  id="authorName"
                  {...register('authorName')}
                  placeholder="Author's name"
                  className={errors.authorName ? 'border-destructive' : ''}
                />
                {errors.authorName && (
                  <p className="text-xs text-destructive">{errors.authorName.message}</p>
                )}
              </div>
              <div className="space-y-2">
                <Label htmlFor="authorEmail">Author email</Label>
                <Input
                  id="authorEmail"
                  {...register('authorEmail')}
                  type="email"
                  placeholder="author@example.com"
                  className={errors.authorEmail ? 'border-destructive' : ''}
                />
                {errors.authorEmail && (
                  <p className="text-xs text-destructive">{errors.authorEmail.message}</p>
                )}
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="organization">Organization</Label>
              <Input
                id="organization"
                {...register('organization')}
                placeholder="Organization name"
                className={errors.organization ? 'border-destructive' : ''}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="contactOther">Contact (website, phone)</Label>
              <Input
                id="contactOther"
                {...register('contactOther')}
                placeholder="Other contact"
                className={errors.contactOther ? 'border-destructive' : ''}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="termsOfUseUrl">Terms of use URL</Label>
              <Input
                id="termsOfUseUrl"
                {...register('termsOfUseUrl')}
                placeholder="https://..."
                className={errors.termsOfUseUrl ? 'border-destructive' : ''}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="privacyPolicyUrl">Privacy policy URL</Label>
              <Input
                id="privacyPolicyUrl"
                {...register('privacyPolicyUrl')}
                placeholder="https://..."
                className={errors.privacyPolicyUrl ? 'border-destructive' : ''}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="otherUrl">Other URL (support, etc.)</Label>
              <Input
                id="otherUrl"
                {...register('otherUrl')}
                placeholder="https://..."
                className={errors.otherUrl ? 'border-destructive' : ''}
              />
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="capabilityName">Capability name</Label>
                <Input
                  id="capabilityName"
                  {...register('capabilityName')}
                  placeholder="e.g. Text Generation"
                  className={errors.capabilityName ? 'border-destructive' : ''}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="capabilityVersion">Capability version</Label>
                <Input
                  id="capabilityVersion"
                  {...register('capabilityVersion')}
                  placeholder="e.g. 1.0.0"
                  className={errors.capabilityVersion ? 'border-destructive' : ''}
                />
              </div>
            </div>
          </CardContent>
        </Card>

        <div className="flex flex-wrap items-center justify-center gap-3">
          <Button type="button" variant="outline" onClick={ignoreSetup}>
            Skip for now
          </Button>
          <Button type="submit" disabled={isLoading} className="gap-2">
            {isLoading ? 'Adding...' : 'Add agent'} <ArrowRight className="h-4 w-4" />
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
    <Card className="w-full max-w-lg border-0 shadow-lg bg-card/50">
      <CardHeader className="text-center pb-2">
        <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-green-500/15">
          <CheckCircle2 className="h-8 w-8 text-green-600 dark:text-green-500" />
        </div>
        <CardTitle className="text-2xl">You&apos;re all set!</CardTitle>
        <CardDescription className="text-base mt-1">
          Your <span className="font-medium text-foreground">{networkDisplay}</span> environment is
          ready.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6 pt-2">
        <ul className="text-sm text-muted-foreground space-y-2 text-left max-w-xs mx-auto">
          <li className="flex items-center gap-2">
            <CheckCircle2 className="h-4 w-4 text-green-600 dark:text-green-500 shrink-0" />
            Wallets created and saved
          </li>
          <li className="flex items-center gap-2">
            <CheckCircle2 className="h-4 w-4 text-green-600 dark:text-green-500 shrink-0" />
            Payment source configured
          </li>
          {hasAiAgent && (
            <li className="flex items-center gap-2">
              <CheckCircle2 className="h-4 w-4 text-green-600 dark:text-green-500 shrink-0" />
              First AI agent registered
            </li>
          )}
        </ul>
        <p className="text-sm text-muted-foreground text-center">
          Head to the dashboard to manage payment sources, agents, and transactions.
        </p>
        <div className="flex justify-center">
          <Button onClick={onComplete} className="gap-2">
            Go to dashboard <ArrowRight className="h-4 w-4" />
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

export function SetupWelcome({ networkType }: { networkType: string }) {
  const { setSetupWizardStep } = useAppContext();
  const [currentStep, setCurrentStep] = useState(0);
  const [wallets, setWallets] = useState<{
    buying: { address: string; mnemonic: string } | null;
    selling: { address: string; mnemonic: string } | null;
  }>({
    buying: null,
    selling: null,
  });
  const [hasAiAgent, setHasAiAgent] = useState(false);

  useEffect(() => {
    setCurrentStep(0);
    setWallets({ buying: null, selling: null });
  }, [networkType]);

  useEffect(() => {
    setSetupWizardStep(currentStep);
  }, [currentStep, setSetupWizardStep]);

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

  const totalSteps = steps.length;
  const showStepper = currentStep > 0 && currentStep < totalSteps - 1;

  return (
    <div className="w-full max-w-2xl mx-auto px-4">
      {showStepper && (
        <div className="mb-8">
          <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-3">
            Step {currentStep + 1} of {totalSteps}
          </p>
          <div className="flex gap-1">
            {STEP_LABELS.slice(1, -1).map((_label, i) => {
              const stepIndex = i + 1;
              const isComplete = currentStep > stepIndex;
              const isCurrent = currentStep === stepIndex;
              return (
                <div
                  key={stepIndex}
                  className={cn(
                    'h-1.5 flex-1 rounded-full transition-colors',
                    isComplete && 'bg-primary',
                    isCurrent && 'bg-primary',
                    !isComplete && !isCurrent && 'bg-muted',
                  )}
                  title={STEP_LABELS[stepIndex]}
                />
              );
            })}
          </div>
          <p className="text-sm text-muted-foreground mt-2">{STEP_LABELS[currentStep]}</p>
        </div>
      )}
      <div className="flex flex-col items-center justify-center min-h-[calc(100vh-240px)] py-8">
        {steps[currentStep]}
      </div>
    </div>
  );
}
