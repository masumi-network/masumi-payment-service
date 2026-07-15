import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Spinner } from '@/components/ui/spinner';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import {
  Key,
  ArrowRight,
  Copy,
  AlertTriangle,
  ChevronDown,
  ChevronUp,
  Info,
  ExternalLink,
} from 'lucide-react';
import { useAppContext } from '@/lib/contexts/AppContext';
import { cn, shortenAddress } from '@/lib/utils';
import { PaymentSourceTypeBadge } from '@/components/payment-sources/PaymentSourceTypeBadge';
import { DEFAULT_PAYMENT_SOURCE_TYPE } from '@/lib/payment-source-type';
import {
  usePaymentSourceSetup,
  paymentSourceSchema,
  type PaymentSourceFormValues,
} from '@/lib/hooks/usePaymentSourceSetup';
import { copyToClipboard, type SetupWallet } from '@/components/setup/setup-helpers';

export function PaymentSourceSetupScreen({
  onNext,
  buyingWallet,
  sellingWallet,
  ignoreSetup,
}: {
  onNext: () => void;
  buyingWallet: SetupWallet | null;
  sellingWallet: SetupWallet | null;
  ignoreSetup: () => void;
}) {
  const { network } = useAppContext();
  const [customConfigOpen, setCustomConfigOpen] = useState(false);
  const { isLoading, error, adminWallets, createPaymentSource } = usePaymentSourceSetup();

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

  const onSubmit = (data: PaymentSourceFormValues) =>
    createPaymentSource(data, buyingWallet, sellingWallet, onNext);

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
                              aria-label="Copy address"
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
