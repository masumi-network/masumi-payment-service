import { Fragment, useMemo, useState } from 'react';
import { useRouter } from 'next/router';
import { useQueryClient } from '@tanstack/react-query';
import {
  ArrowRight,
  Check,
  CheckCircle2,
  Coins,
  Link2,
  Sparkles,
  Wallet as WalletIcon,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Spinner } from '@/components/ui/spinner';
import { cn } from '@/lib/utils';
import { useAppContext, type NetworkType } from '@/lib/contexts/AppContext';
import { useX402Budgets, useX402Networks, useX402Wallets } from '@/lib/hooks/useX402';
import { chainsForEnv, isTestnetEnv, X402_ACCENT } from '@/lib/x402-rail';
import { X402Network, X402Wallet } from '@/lib/api/generated';
import { CreateWalletDialog } from '@/components/x402/WalletsTab';
import { ChainDialog } from '@/components/x402/ChainsTab';
import { BudgetDialog } from '@/components/x402/BudgetsTab';

/** Three-stage progress indicator: Welcome → Configure → Ready. */
function WizardProgress({ current }: { current: 1 | 2 | 3 }) {
  const labels = ['Welcome', 'Configure', 'Ready'];
  return (
    <div className="mx-auto mb-7 w-full max-w-xs">
      <div className="flex items-center justify-center">
        {labels.map((label, index) => {
          const step = index + 1;
          const done = step < current;
          const active = step === current;
          return (
            <Fragment key={label}>
              <div
                className={cn(
                  'flex h-7 w-7 items-center justify-center rounded-full text-xs font-semibold transition-all duration-300',
                  done && 'bg-primary text-primary-foreground',
                  active && 'bg-primary text-primary-foreground ring-4 ring-primary/20 scale-110',
                  !done && !active && 'bg-muted text-muted-foreground',
                )}
                title={label}
              >
                {done ? <Check className="h-3.5 w-3.5 animate-pop-in" /> : step}
              </div>
              {step < 3 && (
                <div
                  className={cn(
                    'mx-1.5 h-0.5 w-10 rounded-full transition-colors duration-500',
                    done ? 'bg-primary' : 'bg-muted',
                  )}
                />
              )}
            </Fragment>
          );
        })}
      </div>
      <p className="mt-3 text-center text-xs font-medium text-muted-foreground">
        {labels[current - 1]}
      </p>
    </div>
  );
}

type DialogKind = 'wallet' | 'chain' | 'budget' | null;

/**
 * Guided first-run setup for the x402 (EVM) rail — the EVM-context analogue of the
 * Cardano `/setup` wizard. It mirrors that wizard's welcome → steps → success shell, but
 * reuses the existing x402 dialogs (CreateWalletDialog / ChainDialog / BudgetDialog) so
 * there is no second source of truth for creating these records — the same philosophy as
 * X402SetupGuide.
 */
export function X402SetupWelcome({ networkType }: { networkType: NetworkType }) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { authorized, setActiveRail, setSelectedX402ChainId, setIsSetupMode } = useAppContext();
  const { wallets, isLoading: walletsLoading } = useX402Wallets();
  const { networks, isLoading: networksLoading } = useX402Networks();
  const { budgets, isLoading: budgetsLoading } = useX402Budgets();

  const [currentStep, setCurrentStep] = useState(0);
  const [openDialog, setOpenDialog] = useState<DialogKind>(null);
  const [walletType, setWalletType] = useState<X402Wallet['type']>('Selling');

  // The x402 hooks are disabled (and return []) until authorized, which would otherwise
  // read as "nothing configured". Treat the pre-auth window as loading so step state and
  // finish() never act on empty data.
  const loading = !authorized || walletsLoading || networksLoading || budgetsLoading;

  const envChains = useMemo(() => chainsForEnv(networks, networkType), [networks, networkType]);
  const hasWallet = wallets.length > 0;
  // Wallets are split by direction: a Selling wallet settles inbound payments (facilitator),
  // a Purchasing wallet funds outbound ones (budget). Each capability needs its own type.
  const hasSellingWallet = wallets.some((wallet) => wallet.type === 'Selling');
  const hasPurchasingWallet = wallets.some((wallet) => wallet.type === 'Purchasing');
  const hasFacilitator = envChains.some((chain) => !!chain.facilitatorWalletId);
  // Scope budgets to the active environment (by the budget's chain), so a budget on the
  // other env doesn't mark this env's optional step complete or skew the success summary.
  const envCaip2 = useMemo(() => {
    const wantTestnet = isTestnetEnv(networkType);
    return new Set(
      networks.filter((network) => network.isTestnet === wantTestnet).map((n) => n.caip2Id),
    );
  }, [networks, networkType]);
  const hasBudget = budgets.some((budget) => envCaip2.has(budget.caip2Network));

  // Prefer attaching a facilitator to an enabled chain in the active env that lacks one
  // (Base ships preconfigured by the seed), then any chain in the same env. Never cross
  // environments: editing a mainnet chain while configuring Preprod would mislead the
  // user. When the env has no chain yet, leave it null so the dialog opens in create mode.
  const chainToConfigure: X402Network | null = useMemo(() => {
    const wantTestnet = isTestnetEnv(networkType);
    const envScoped = networks.filter((network) => network.isTestnet === wantTestnet);
    return (
      envScoped.find((network) => network.isEnabled && !network.facilitatorWalletId) ??
      envScoped[0] ??
      null
    );
  }, [networks, networkType]);

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['x402-wallets'] });
    queryClient.invalidateQueries({ queryKey: ['x402-networks'] });
    queryClient.invalidateQueries({ queryKey: ['x402-budgets'] });
  };

  const openWalletDialog = (type: X402Wallet['type']) => {
    setWalletType(type);
    setOpenDialog('wallet');
  };

  // Reachable only once the receive side is usable (a facilitator exists), so the success
  // screen's "x402 is ready" claim agrees with isX402SetUpForEnv used by the banner/selector.
  const finish = () => {
    // Read the chain from the current render's data BEFORE invalidating — invalidation is
    // async, so reading after it could see the pre-save list and skip the selection.
    const configured =
      envChains.find((chain) => !!chain.facilitatorWalletId) ?? envChains[0] ?? null;
    if (configured) setSelectedX402ChainId(configured.id);
    setActiveRail('x402');
    // Clear any persisted Cardano setup mode, otherwise _app's setup-mode guard bounces
    // /x402 straight back to /setup right after finishing the EVM setup.
    setIsSetupMode(false);
    invalidate();
    router.push('/x402');
  };

  const steps = [
    {
      done: hasWallet,
      icon: WalletIcon,
      title: 'Create a managed EVM wallet',
      body: 'Generates an EVM keypair (or import your own). The private key is encrypted at rest and never leaves the server. Wallets are split by direction: a Selling wallet settles inbound payments, a Purchasing wallet funds outbound ones.',
      actionLabel: hasWallet ? 'Add another wallet' : 'Create wallet',
      onAction: () => openWalletDialog('Selling'),
    },
    {
      done: hasFacilitator,
      icon: Link2,
      title: 'Enable a chain & assign a facilitator',
      body: `Pick an EVM chain for ${networkType} (Base is preconfigured) and assign a Selling wallet as its facilitator so it can settle inbound x402 payments — the sell side.`,
      // A facilitator must be a Selling wallet; create one first if none exists.
      actionLabel: hasFacilitator
        ? 'Manage chain'
        : hasSellingWallet
          ? 'Configure chain'
          : 'Create selling wallet',
      onAction: () => (hasSellingWallet ? setOpenDialog('chain') : openWalletDialog('Selling')),
    },
    {
      done: hasBudget,
      icon: Coins,
      title: 'Fund a spend budget (optional)',
      body: 'Grant an API key a capped budget on a Purchasing wallet and token so it can sign outbound payments to other x402 resources — the buy side. Skip if you only receive payments.',
      // A budget draws from a Purchasing wallet; create one first if none exists.
      actionLabel: hasBudget
        ? 'Manage budgets'
        : hasPurchasingWallet
          ? 'Set budget'
          : 'Create purchasing wallet',
      onAction: () =>
        hasPurchasingWallet ? setOpenDialog('budget') : openWalletDialog('Purchasing'),
      optional: true,
    },
  ];

  // ---- Welcome screen --------------------------------------------------------------
  if (currentStep === 0) {
    return (
      <div className="mx-auto max-w-2xl px-4">
        <WizardProgress current={1} />
        <Card className="animate-scale-in-bounce overflow-hidden border-indigo-300/40 bg-gradient-to-br from-indigo-50/60 to-background p-8 text-center dark:border-indigo-900/40 dark:from-indigo-950/20">
          <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-indigo-500/50 to-transparent" />
          <div className="relative mx-auto mb-5 h-14 w-14 animate-fade-in-up">
            <div className="absolute inset-0 rounded-2xl bg-indigo-500/20 blur-xl" />
            <div className="relative flex h-14 w-14 items-center justify-center rounded-2xl bg-gradient-to-br from-indigo-500/20 to-indigo-500/5 ring-1 ring-indigo-500/30">
              <Coins className={cn('h-7 w-7', X402_ACCENT.icon)} />
            </div>
          </div>
          <div className="mb-2 flex animate-fade-in-up items-center justify-center gap-2 animate-delay-75">
            <h1 className="text-2xl font-semibold tracking-tight">Set up the x402 (EVM) rail</h1>
            <Badge variant="outline" className="font-medium">
              EVM
            </Badge>
            <Badge variant="secondary" className="font-medium">
              {networkType}
            </Badge>
          </div>
          <p className="mx-auto mb-6 max-w-lg animate-fade-in-up text-sm text-muted-foreground animate-delay-100">
            Let your agents pay, and get paid by, other agents over EVM chains using stablecoins.
            This quick setup creates a managed wallet, enables a chain, and (optionally) funds a
            spend budget.
          </p>
          <div className="mb-8 grid gap-3 sm:grid-cols-3">
            {[
              { icon: WalletIcon, label: 'Managed wallet', delay: 'animate-delay-100' },
              { icon: Link2, label: 'Enabled chain', delay: 'animate-delay-125' },
              { icon: Sparkles, label: 'Ready to transact', delay: 'animate-delay-150' },
            ].map((feature) => (
              <div
                key={feature.label}
                style={{ animationFillMode: 'forwards' }}
                className={cn(
                  'flex animate-slide-in-bottom flex-col items-center gap-2 rounded-lg border bg-background/60 p-4 opacity-0 transition-colors hover:bg-background',
                  feature.delay,
                )}
              >
                <feature.icon className={cn('h-5 w-5', X402_ACCENT.icon)} />
                <span className="text-xs font-medium text-muted-foreground">{feature.label}</span>
              </div>
            ))}
          </div>
          <Button
            size="lg"
            className="btn-hover-lift group gap-2 animate-delay-175"
            onClick={() => setCurrentStep(1)}
          >
            Get started
            <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-1" />
          </Button>
        </Card>
      </div>
    );
  }

  // ---- Success screen --------------------------------------------------------------
  if (currentStep === 2) {
    return (
      <div className="mx-auto max-w-2xl px-4">
        <WizardProgress current={3} />
        <Card className="animate-scale-in-bounce overflow-hidden p-8 text-center">
          <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-green-500/50 to-transparent" />
          <div className="relative mx-auto mb-5 h-16 w-16 animate-fade-in-up">
            <div className="absolute inset-0 rounded-full bg-green-500/10 blur-xl" />
            <div className="relative flex h-16 w-16 items-center justify-center rounded-full bg-gradient-to-br from-green-500/20 to-green-600/10 ring-2 ring-green-500/30">
              <CheckCircle2 className="h-8 w-8 text-green-600 dark:text-green-500" />
            </div>
          </div>
          <h1 className="mb-2 animate-fade-in-up text-2xl font-semibold tracking-tight animate-delay-75">
            x402 is ready
          </h1>
          <p className="mx-auto mb-6 max-w-lg animate-fade-in-up text-sm text-muted-foreground animate-delay-100">
            The EVM rail is configured for {networkType}. You can manage chains, wallets, budgets
            and payments any time from the x402 page.
          </p>
          <div className="mx-auto mb-8 max-w-sm space-y-2 text-left">
            {steps.map((step, index) => (
              <div
                key={step.title}
                style={{ animationFillMode: 'forwards' }}
                className={cn(
                  'flex animate-slide-in-bottom items-center gap-2.5 rounded-lg border px-3 py-2.5 text-sm opacity-0',
                  step.done
                    ? 'border-green-500/20 bg-green-500/5'
                    : 'border-border bg-muted/30 text-muted-foreground',
                  index === 0 && 'animate-delay-100',
                  index === 1 && 'animate-delay-125',
                  index === 2 && 'animate-delay-150',
                )}
              >
                <CheckCircle2
                  className={cn(
                    'h-4 w-4 shrink-0',
                    step.done ? 'text-green-600 dark:text-green-500' : 'text-muted-foreground/40',
                  )}
                />
                <span>
                  {step.title}
                  {step.optional && !step.done ? ' (skipped)' : ''}
                </span>
              </div>
            ))}
          </div>
          <Button size="lg" className="btn-hover-lift group gap-2" onClick={finish}>
            Go to x402
            <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-1" />
          </Button>
        </Card>
      </div>
    );
  }

  // ---- Steps screen (currentStep === 1) --------------------------------------------
  return (
    <div className="mx-auto max-w-2xl px-4">
      <WizardProgress current={2} />
      <div className="mb-6 space-y-1 text-center">
        <h1 className="text-xl font-semibold tracking-tight">Configure the x402 rail</h1>
        <p className="text-sm text-muted-foreground">
          Complete the steps below for {networkType}. The first two enable receiving payments; the
          budget is optional.
        </p>
      </div>

      {loading ? (
        <div className="flex justify-center py-16">
          <Spinner />
        </div>
      ) : (
        <div className="space-y-3">
          {steps.map((step, index) => {
            const StepIcon = step.icon;
            return (
              <Card
                key={step.title}
                style={{ animationFillMode: 'forwards' }}
                className={cn(
                  'flex animate-slide-in-bottom flex-col gap-3 p-4 opacity-0 transition-colors sm:flex-row sm:items-start',
                  step.done ? 'border-green-500/20 bg-green-500/[0.04]' : 'hover:border-primary/30',
                  index === 0 && 'animate-delay-50',
                  index === 1 && 'animate-delay-100',
                  index === 2 && 'animate-delay-150',
                )}
              >
                <div className="mt-0.5 shrink-0">
                  {step.done ? (
                    <CheckCircle2 className="h-7 w-7 animate-pop-in text-green-600 dark:text-green-500" />
                  ) : (
                    <div className="flex h-7 w-7 items-center justify-center rounded-full bg-primary/10 text-xs font-semibold text-primary">
                      {index + 1}
                    </div>
                  )}
                </div>
                <div className="flex-1 space-y-1">
                  <div className="flex items-center gap-2">
                    <StepIcon
                      className={cn(
                        'h-4 w-4',
                        step.done ? 'text-green-600 dark:text-green-500' : X402_ACCENT.icon,
                      )}
                    />
                    <p className={cn('text-sm font-medium', step.done && 'text-muted-foreground')}>
                      {step.title}
                    </p>
                  </div>
                  <p className="text-xs leading-snug text-muted-foreground">{step.body}</p>
                </div>
                <Button
                  variant={step.done ? 'outline' : 'default'}
                  size="sm"
                  className="group shrink-0 self-start"
                  onClick={step.onAction}
                >
                  {step.actionLabel}
                  {!step.done && (
                    <ArrowRight className="ml-1 h-3.5 w-3.5 transition-transform group-hover:translate-x-0.5" />
                  )}
                </Button>
              </Card>
            );
          })}

          <div className="flex items-center justify-between pt-2">
            <Button variant="ghost" onClick={() => setCurrentStep(0)}>
              Back
            </Button>
            <div className="flex items-center gap-2">
              <Button variant="ghost" onClick={finish}>
                Exit to x402
              </Button>
              <Button
                className="gap-2"
                disabled={!hasFacilitator}
                title={
                  hasFacilitator ? undefined : 'Enable a chain and assign a facilitator to finish'
                }
                onClick={() => setCurrentStep(2)}
              >
                Finish
                <ArrowRight className="h-4 w-4" />
              </Button>
            </div>
          </div>
        </div>
      )}

      <CreateWalletDialog
        key={openDialog === 'wallet' ? `wallet-open-${walletType}` : 'wallet-closed'}
        open={openDialog === 'wallet'}
        defaultType={walletType}
        onClose={() => setOpenDialog(null)}
        onSaved={() => {
          setOpenDialog(null);
          invalidate();
        }}
      />
      <ChainDialog
        key={openDialog === 'chain' ? `chain-${chainToConfigure?.id ?? 'new'}` : 'chain-closed'}
        open={openDialog === 'chain'}
        editing={chainToConfigure}
        onClose={() => setOpenDialog(null)}
        onSaved={() => {
          setOpenDialog(null);
          invalidate();
        }}
      />
      <BudgetDialog
        key={openDialog === 'budget' ? 'budget-open' : 'budget-closed'}
        open={openDialog === 'budget'}
        editing={null}
        onClose={() => setOpenDialog(null)}
        onSaved={() => {
          setOpenDialog(null);
          invalidate();
        }}
      />
    </div>
  );
}
