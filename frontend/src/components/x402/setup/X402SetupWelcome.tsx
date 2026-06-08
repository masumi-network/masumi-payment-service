import { useMemo, useState } from 'react';
import { useRouter } from 'next/router';
import { useQueryClient } from '@tanstack/react-query';
import { ArrowRight, Check, CheckCircle2, Coins, Link2, Wallet as WalletIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Spinner } from '@/components/ui/spinner';
import { cn, shortenAddress } from '@/lib/utils';
import { useAppContext, type NetworkType } from '@/lib/contexts/AppContext';
import { useX402Budgets, useX402Networks, useX402Wallets } from '@/lib/hooks/useX402';
import { chainsForEnv, isTestnetEnv, X402_ACCENT } from '@/lib/x402-rail';
import { X402Network, X402Wallet } from '@/lib/api/generated';
import { CreateWalletDialog } from '@/components/x402/WalletsTab';
import { ChainDialog } from '@/components/x402/ChainsTab';
import { BudgetDialog } from '@/components/x402/BudgetsTab';

// Stage labels for the wizard. As in the Cardano /setup wizard, the first (Welcome) and last
// (Ready) stages are not shown in the numbered stepper; only the middle steps are.
const STEP_LABELS = ['Welcome', 'Receiving', 'Paying', 'Ready'];

type DialogKind = 'wallet' | 'chain' | 'budget' | null;
type LucideIcon = typeof Link2;

// The header icon shared by the step screens: the same glow + ring treatment as the Cardano
// wizard, tinted with the x402 rail's indigo accent for rail identity.
function StepHeaderIcon({ icon: Icon }: { icon: LucideIcon }) {
  return (
    <div className="relative mx-auto mb-5 h-14 w-14 animate-fade-in-up">
      <div className="absolute inset-0 rounded-2xl bg-indigo-500/20 blur-xl" />
      <div className="relative flex h-14 w-14 items-center justify-center rounded-2xl bg-gradient-to-br from-indigo-500/20 to-indigo-500/5 ring-1 ring-indigo-500/30">
        <Icon className={cn('h-7 w-7', X402_ACCENT.icon)} />
      </div>
    </div>
  );
}

/**
 * Guided first-run setup for the x402 (EVM) rail. Mirrors the Cardano `/setup` wizard's
 * multi-screen shape (welcome card → one screen per step with a top "Step X of N" stepper →
 * success card) and reuses the existing x402 dialogs so there is no second source of truth.
 */
export function X402SetupWelcome({ networkType }: { networkType: NetworkType }) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { authorized, setActiveRail, setSelectedX402ChainId, setIsSetupMode } = useAppContext();
  const { wallets, isLoading: walletsLoading } = useX402Wallets();
  const { networks, isLoading: networksLoading } = useX402Networks({ network: networkType });
  const { budgets, isLoading: budgetsLoading } = useX402Budgets();

  const [currentStep, setCurrentStep] = useState(0);
  const [openDialog, setOpenDialog] = useState<DialogKind>(null);
  const [walletType, setWalletType] = useState<X402Wallet['type']>('Selling');

  // The x402 hooks are disabled (and return []) until authorized, which would otherwise read
  // as "nothing configured". Treat the pre-auth window as loading so step state never acts on
  // empty data.
  const loading = !authorized || walletsLoading || networksLoading || budgetsLoading;

  const envChains = useMemo(() => chainsForEnv(networks, networkType), [networks, networkType]);
  // Wallets are split by direction: a Selling wallet settles inbound payments (facilitator),
  // a Purchasing wallet funds outbound ones (budget). Each step owns its type.
  const hasSellingWallet = wallets.some((wallet) => wallet.type === 'Selling');
  const hasPurchasingWallet = wallets.some((wallet) => wallet.type === 'Purchasing');
  const hasFacilitator = envChains.some((chain) => !!chain.facilitatorWalletId);
  const configuredChain = envChains.find((chain) => !!chain.facilitatorWalletId) ?? null;
  // Scope budgets to the active environment so a budget on the other env doesn't mark this
  // env's optional step complete.
  const envCaip2 = useMemo(() => {
    const wantTestnet = isTestnetEnv(networkType);
    return new Set(networks.filter((n) => n.isTestnet === wantTestnet).map((n) => n.caip2Id));
  }, [networks, networkType]);
  const hasBudget = budgets.some((budget) => envCaip2.has(budget.caip2Network));

  // Prefer attaching a facilitator to an enabled chain in the active env that lacks one (Base
  // ships preconfigured), then any chain in the same env, never crossing environments.
  const chainToConfigure: X402Network | null = useMemo(() => {
    const wantTestnet = isTestnetEnv(networkType);
    const envScoped = networks.filter((n) => n.isTestnet === wantTestnet);
    return envScoped.find((n) => n.isEnabled && !n.facilitatorWalletId) ?? envScoped[0] ?? null;
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

  const finish = () => {
    // Read the chain from the current render BEFORE invalidating (invalidation is async).
    const configured = envChains.find((c) => !!c.facilitatorWalletId) ?? envChains[0] ?? null;
    if (configured) setSelectedX402ChainId(configured.id);
    setActiveRail('x402');
    setIsSetupMode(false);
    invalidate();
    router.push('/x402');
  };

  // Chips for the wallets the operator already has of a direction, so each step reflects state
  // rather than re-asking them to create one.
  const walletChips = (type: X402Wallet['type']) => {
    const matching = wallets.filter((wallet) => wallet.type === type);
    if (matching.length === 0) return null;
    return (
      <div className="flex flex-wrap justify-center gap-1.5">
        {matching.map((wallet) => (
          <span
            key={wallet.id}
            className="inline-flex items-center gap-1 rounded-md border bg-muted/40 px-2 py-0.5 font-mono text-xs"
            title={wallet.address}
          >
            {wallet.note ? `${wallet.note} · ` : ''}
            {shortenAddress(wallet.address, 6)}
          </span>
        ))}
      </div>
    );
  };

  // ---- Screens ---------------------------------------------------------------------------

  const welcomeScreen = (
    <Card className="mx-auto w-full max-w-lg animate-scale-in-bounce border bg-gradient-to-b from-card to-card/80 shadow-xl">
      <CardHeader className="pb-4 pt-8 text-center">
        <StepHeaderIcon icon={Coins} />
        <CardTitle className="flex animate-fade-in-up items-center justify-center gap-2 text-3xl font-bold">
          Set up the x402 rail
        </CardTitle>
        <CardDescription className="mt-2 animate-fade-in-up text-base animate-delay-75">
          Let your agents pay, and get paid by, other agents over EVM chains using stablecoins on{' '}
          <span className="font-medium text-foreground">{networkType}</span>.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6 pb-8">
        <div className="space-y-3">
          {[
            { icon: WalletIcon, label: 'Create a managed wallet', delay: 'animate-delay-100' },
            { icon: Link2, label: 'Assign a chain facilitator', delay: 'animate-delay-125' },
            { icon: Coins, label: 'Fund a spend budget (optional)', delay: 'animate-delay-150' },
          ].map((feature) => (
            <div
              key={feature.label}
              style={{ animationFillMode: 'forwards' }}
              className={cn(
                'flex animate-slide-in-left items-center gap-3 rounded-lg border bg-muted/30 px-4 py-3 opacity-0 transition-colors duration-150 hover:bg-muted/50',
                feature.delay,
              )}
            >
              <div className="flex h-9 w-9 items-center justify-center rounded-full bg-indigo-500/10">
                <feature.icon className={cn('h-4 w-4', X402_ACCENT.icon)} />
              </div>
              <span className="text-sm font-medium">{feature.label}</span>
            </div>
          ))}
        </div>
        <div
          className="animate-fade-in-up pt-2 opacity-0 animate-delay-225"
          style={{ animationFillMode: 'forwards' }}
        >
          <Button
            onClick={() => setCurrentStep(1)}
            className="btn-hover-lift group h-11 w-full gap-2 text-base"
            size="lg"
          >
            Get started{' '}
            <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-1" />
          </Button>
        </div>
      </CardContent>
    </Card>
  );

  const receivingScreen = (
    <div className="mx-auto w-full max-w-lg">
      <div className="text-center">
        <StepHeaderIcon icon={Link2} />
        <h1 className="text-2xl font-bold tracking-tight">Enable receiving payments</h1>
        <p className="mx-auto mt-2 max-w-md text-sm text-muted-foreground">
          Create a Selling wallet and assign it as the facilitator on an EVM chain (Base is
          preconfigured) so your agents can be paid over x402.
        </p>
      </div>

      <Card
        className={cn(
          'mt-6 space-y-4 p-5 text-center',
          hasFacilitator && 'border-green-500/20 bg-green-500/[0.04]',
        )}
      >
        {walletChips('Selling')}
        {hasFacilitator && configuredChain ? (
          <p className="flex items-center justify-center gap-1.5 text-sm text-green-600 dark:text-green-500">
            <CheckCircle2 className="h-4 w-4" /> Facilitator set on {configuredChain.displayName}
          </p>
        ) : (
          <p className="text-xs text-muted-foreground">
            {hasSellingWallet
              ? 'Assign your Selling wallet as a chain facilitator to start receiving.'
              : 'Create a Selling wallet to act as the chain facilitator.'}
          </p>
        )}
        <Button
          variant={hasFacilitator ? 'outline' : 'default'}
          className="gap-2"
          onClick={() => (hasSellingWallet ? setOpenDialog('chain') : openWalletDialog('Selling'))}
        >
          {!hasSellingWallet
            ? 'Create selling wallet'
            : hasFacilitator
              ? 'Manage chain'
              : 'Assign facilitator'}
        </Button>
      </Card>

      <div className="flex items-center justify-between pt-6">
        <Button variant="ghost" onClick={() => setCurrentStep(0)}>
          Back
        </Button>
        <Button
          className="btn-hover-lift group gap-2"
          disabled={!hasFacilitator}
          title={hasFacilitator ? undefined : 'Assign a chain facilitator to continue'}
          onClick={() => setCurrentStep(2)}
        >
          Continue <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-1" />
        </Button>
      </div>
    </div>
  );

  const payingScreen = (
    <div className="mx-auto w-full max-w-lg">
      <div className="text-center">
        <StepHeaderIcon icon={Coins} />
        <h1 className="flex items-center justify-center gap-2 text-2xl font-bold tracking-tight">
          Enable outbound payments
          <Badge variant="secondary" className="font-medium">
            Optional
          </Badge>
        </h1>
        <p className="mx-auto mt-2 max-w-md text-sm text-muted-foreground">
          Create a Purchasing wallet and grant an API key a capped budget so your agents can pay
          other x402 resources. Skip if you only receive payments.
        </p>
      </div>

      <Card
        className={cn(
          'mt-6 space-y-4 p-5 text-center',
          hasBudget && 'border-green-500/20 bg-green-500/[0.04]',
        )}
      >
        {walletChips('Purchasing')}
        {hasBudget ? (
          <p className="flex items-center justify-center gap-1.5 text-sm text-green-600 dark:text-green-500">
            <CheckCircle2 className="h-4 w-4" /> Spend budget configured
          </p>
        ) : (
          <p className="text-xs text-muted-foreground">
            {hasPurchasingWallet
              ? 'Grant an API key a spend budget on your Purchasing wallet.'
              : 'Create a Purchasing wallet to fund outbound payments.'}
          </p>
        )}
        <Button
          variant={hasBudget ? 'outline' : 'default'}
          className="gap-2"
          onClick={() =>
            hasPurchasingWallet ? setOpenDialog('budget') : openWalletDialog('Purchasing')
          }
        >
          {!hasPurchasingWallet
            ? 'Create purchasing wallet'
            : hasBudget
              ? 'Manage budgets'
              : 'Set budget'}
        </Button>
      </Card>

      <div className="flex items-center justify-between pt-6">
        <Button variant="ghost" onClick={() => setCurrentStep(1)}>
          Back
        </Button>
        <Button className="btn-hover-lift group gap-2" onClick={() => setCurrentStep(3)}>
          {hasBudget ? 'Continue' : 'Skip for now'}
          <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-1" />
        </Button>
      </div>
    </div>
  );

  const successScreen = (
    <Card className="mx-auto w-full max-w-lg animate-scale-in-bounce overflow-hidden border bg-gradient-to-b from-card to-card/80 shadow-xl">
      <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-green-500/50 to-transparent" />
      <CardHeader className="pb-4 pt-10 text-center">
        <div className="relative mx-auto mb-6 h-20 w-20 animate-fade-in-up">
          <div className="absolute inset-0 rounded-full bg-green-500/10 blur-xl" />
          <div className="relative flex h-20 w-20 items-center justify-center rounded-full bg-gradient-to-br from-green-500/20 to-green-600/10 ring-2 ring-green-500/30">
            <CheckCircle2 className="h-10 w-10 text-green-600 dark:text-green-500" />
          </div>
        </div>
        <CardTitle className="animate-fade-in-up text-3xl font-bold animate-delay-75">
          x402 is ready
        </CardTitle>
        <CardDescription className="mt-2 animate-fade-in-up text-base animate-delay-100">
          Your <span className="font-medium text-foreground">{networkType}</span> EVM rail is ready
          to use
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6 pb-8">
        <div className="space-y-3">
          {[
            { label: 'Receiving payments enabled', done: hasFacilitator, optional: false },
            { label: 'Outbound payments enabled', done: hasBudget, optional: true },
          ].map((item, index) => (
            <div
              key={item.label}
              style={{ animationFillMode: 'forwards' }}
              className={cn(
                'flex animate-slide-in-bottom items-center gap-3 rounded-lg border px-4 py-3 text-sm opacity-0',
                item.done
                  ? 'border-green-500/20 bg-green-500/5'
                  : 'border-border bg-muted/30 text-muted-foreground',
                index === 0 ? 'animate-delay-125' : 'animate-delay-150',
              )}
            >
              <div
                className={cn(
                  'flex h-8 w-8 items-center justify-center rounded-full',
                  item.done ? 'bg-green-500/10' : 'bg-muted',
                )}
              >
                <Check
                  className={cn(
                    'h-4 w-4',
                    item.done ? 'text-green-600 dark:text-green-500' : 'text-muted-foreground/50',
                  )}
                />
              </div>
              <span className="font-medium">
                {item.label}
                {item.optional && !item.done ? ' (skipped)' : ''}
              </span>
            </div>
          ))}
        </div>
        <div
          className="animate-fade-in-up pt-2 opacity-0 animate-delay-275"
          style={{ animationFillMode: 'forwards' }}
        >
          <Button
            onClick={finish}
            className="btn-hover-lift group h-11 w-full gap-2 text-base"
            size="lg"
          >
            Go to x402{' '}
            <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-1" />
          </Button>
        </div>
      </CardContent>
    </Card>
  );

  const steps = [welcomeScreen, receivingScreen, payingScreen, successScreen];

  // ---- Shell -----------------------------------------------------------------------------

  const totalSteps = STEP_LABELS.length;
  const showStepper = currentStep > 0 && currentStep < totalSteps - 1;
  const stepperSteps = STEP_LABELS.slice(1, -1);

  return (
    <div className="mx-auto w-full max-w-2xl px-4">
      {showStepper && (
        <div className="mb-8 animate-fade-in">
          <div className="mb-4 flex items-center justify-between">
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
          <div className="h-1 overflow-hidden rounded-full bg-muted">
            <div
              className="h-full bg-primary transition-all duration-500 ease-out"
              style={{ width: `${((currentStep - 1) / (stepperSteps.length - 1)) * 100}%` }}
            />
          </div>
        </div>
      )}

      <div className="flex min-h-[calc(100vh-260px)] flex-col items-center justify-center py-8">
        {loading && currentStep > 0 ? (
          <Spinner />
        ) : (
          <div key={currentStep} className="w-full animate-slide-in-right">
            {steps[currentStep]}
          </div>
        )}
      </div>

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
