import { useEffect, useMemo, useRef, useState } from 'react';
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
import { isTestnetEnv, isX402ChainUsable, walletsForNetworks, X402_ACCENT } from '@/lib/x402-rail';
import { useRailReadiness } from '@/lib/hooks/useRailReadiness';
import { areChecksComplete, checkDetail } from '@/lib/rail-readiness';
import { X402Network, X402Wallet } from '@/lib/api/generated';
import { CreateWalletDialog } from '@/components/x402/WalletsTab';
import { ChainForm } from '@/components/x402/ChainsTab';
import { BudgetDialog } from '@/components/x402/BudgetsTab';
import {
  hasSpendableBudgetForChain,
  initialX402SetupStep,
  type X402SetupStep,
} from '@/lib/x402-setup';
import {
  X402ChainSelectionStep,
  X402SetupStepHeaderIcon,
} from '@/components/x402/setup/X402ChainSelectionStep';

// Stage labels for the wizard. As in the Cardano /setup wizard, the first (Welcome) and last
// (Ready) stages are not shown in the numbered stepper; only the middle steps are.
const STEP_LABELS = ['Welcome', 'Chain', 'Receiving', 'Paying', 'Ready'];
const ADD_SOURCE_STEP_LABELS = ['Welcome', 'Chain', 'Receiving', 'Ready'];

type DialogKind = 'wallet' | 'budget' | null;
type ReceivingMode = 'managed' | 'remote';

/**
 * Guided first-run setup for the x402 (EVM) rail. Mirrors the Cardano `/setup` wizard's
 * multi-screen shape (welcome card → one screen per step with a top "Step X of N" stepper →
 * success card) and reuses the existing x402 dialogs so there is no second source of truth.
 */
export function X402SetupWelcome({
  networkType,
  isAddingPaymentSource = false,
}: {
  networkType: NetworkType;
  isAddingPaymentSource?: boolean;
}) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const {
    authorized,
    selectedX402ChainId,
    setActiveRail,
    setSelectedX402ChainId,
    setIsSetupMode,
    setSetupWizardStep,
  } = useAppContext();
  const { wallets, isLoading: walletsLoading } = useX402Wallets();
  const { networks, isLoading: networksLoading } = useX402Networks({ network: networkType });
  const { budgets, isLoading: budgetsLoading } = useX402Budgets();
  // Step completion comes from the backend, not from re-deriving it here. The
  // chain/wallet/budget lists are still read for the affordances below (which
  // chain to configure, which wallet addresses to show) — but whether a step
  // counts as DONE is the server's call.
  const {
    x402: x402Readiness,
    isLoading: readinessLoading,
    isUnavailable: readinessUnavailable,
    refetch: refetchReadiness,
  } = useRailReadiness({ network: networkType });

  const [currentStep, setCurrentStep] = useState<X402SetupStep>(0);
  const [openDialog, setOpenDialog] = useState<DialogKind>(null);
  const [walletType, setWalletType] = useState<X402Wallet['type']>('Selling');
  const [receivingMode, setReceivingMode] = useState<ReceivingMode>('managed');
  const [isCreatingChain, setIsCreatingChain] = useState(false);
  const [isChainEditorOpen, setIsChainEditorOpen] = useState(false);
  const [savedChain, setSavedChain] = useState<X402Network | null>(null);
  const [isAddSourceMode, setIsAddSourceMode] = useState(false);
  const hasInitializedStep = useRef(false);

  // The x402 hooks are disabled (and return []) until authorized, which would otherwise read
  // as "nothing configured". Treat the pre-auth window as loading so step state never acts on
  // empty data.
  const loading =
    !authorized || walletsLoading || networksLoading || budgetsLoading || readinessLoading;

  const envChains = useMemo(() => {
    const wantTestnet = isTestnetEnv(networkType);
    const matching = networks.filter((chain) => chain.isTestnet === wantTestnet);
    if (savedChain?.isTestnet === wantTestnet) {
      return [savedChain, ...matching.filter((chain) => chain.id !== savedChain.id)];
    }
    return matching;
  }, [networks, networkType, savedChain]);
  const envWallets = useMemo(() => walletsForNetworks(wallets, envChains), [wallets, envChains]);
  // Wallets are split by direction: a Selling wallet settles inbound payments (facilitator),
  // a Purchasing wallet funds outbound ones (budget). Each step owns its type.
  // The inbound step is complete only when the rail can actually settle: an
  // enabled chain WITH an RPC URL and exactly one facilitator. Deriving this
  // locally used to pass a facilitator-but-no-RPC chain, marking the step done
  // for a rail that would fail on the first payment.
  const hasFacilitator = x402Readiness?.isReady ?? false;
  const facilitatorDetail = checkDetail(x402Readiness, 'x402.facilitator');
  const selectedChain =
    envChains.find((chain) => chain.id === selectedX402ChainId) ??
    envChains.find(isX402ChainUsable) ??
    envChains[0] ??
    null;
  const configuredChain =
    envChains.find((chain) => isX402ChainUsable(chain)) ??
    envChains.find((chain) => !!chain.facilitatorWalletId || !!chain.facilitatorUrl) ??
    null;
  // Outbound needs both halves — a purchasing wallet and a funded, enabled budget
  // on it. The backend already scopes budgets to this environment's chains.
  const hasBudget = areChecksComplete(x402Readiness, ['x402.purchasing_wallet', 'x402.budget']);
  const selectedChainIsReady = selectedChain ? isX402ChainUsable(selectedChain) : false;
  const isReceivingReadyConfirmed = selectedChainIsReady && hasFacilitator && !readinessUnavailable;
  const selectedSellingWallets = envWallets.filter(
    (wallet) => wallet.type === 'Selling' && wallet.networkId === selectedChain?.id,
  );
  const selectedPurchasingWallets = envWallets.filter(
    (wallet) => wallet.type === 'Purchasing' && wallet.networkId === selectedChain?.id,
  );
  const selectedChainHasBudget = hasSpendableBudgetForChain(budgets, selectedChain?.caip2Id);

  // Prefer attaching a facilitator to an enabled chain in the active env that lacks one (Base
  // ships preconfigured), then any chain in the same env, never crossing environments.
  const chainToConfigure: X402Network | null = selectedChain ?? envChains[0] ?? null;

  useEffect(() => {
    hasInitializedStep.current = false;
    queueMicrotask(() => {
      setCurrentStep(0);
      setReceivingMode('managed');
      setIsCreatingChain(false);
      setIsChainEditorOpen(false);
      setSavedChain(null);
      setIsAddSourceMode(false);
    });
  }, [networkType, isAddingPaymentSource]);

  useEffect(() => {
    setSetupWizardStep(currentStep);
  }, [currentStep, setSetupWizardStep]);

  useEffect(() => {
    if (loading || hasInitializedStep.current) return;
    hasInitializedStep.current = true;
    const shouldAddToReadyRail = isAddingPaymentSource && hasFacilitator;
    const nextStep = initialX402SetupStep({
      isReadinessKnown: !readinessUnavailable,
      isReceivingReady: hasFacilitator,
      isPayingReady: hasBudget,
      startAtChainSelection: shouldAddToReadyRail,
    });
    if (nextStep > 0 && configuredChain) {
      setSelectedX402ChainId(configuredChain.id);
    }
    queueMicrotask(() => {
      setIsAddSourceMode(shouldAddToReadyRail);
      setCurrentStep(nextStep);
    });
  }, [
    configuredChain,
    hasBudget,
    hasFacilitator,
    isAddingPaymentSource,
    loading,
    readinessUnavailable,
    setSelectedX402ChainId,
  ]);

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['x402-wallets'] });
    queryClient.invalidateQueries({ queryKey: ['x402-networks'] });
    queryClient.invalidateQueries({ queryKey: ['x402-budgets'] });
    // Step completion now comes from the readiness endpoint, so it has to be
    // refetched alongside the lists — otherwise a step the user just finished
    // stays incomplete until the 30s staleTime expires.
    queryClient.invalidateQueries({ queryKey: ['rail-readiness'] });
  };

  const openWalletDialog = (type: X402Wallet['type']) => {
    setWalletType(type);
    setOpenDialog('wallet');
  };

  const finish = () => {
    if (selectedChain) setSelectedX402ChainId(selectedChain.id);
    setActiveRail('x402');
    setIsSetupMode(false);
    invalidate();
    router.push('/x402/dashboard');
  };

  // Chips for the wallets the operator already has of a direction, so each step reflects state
  // rather than re-asking them to create one.
  const walletChips = (type: X402Wallet['type']) => {
    const matching = envWallets.filter(
      (wallet) => wallet.type === type && wallet.networkId === selectedChain?.id,
    );
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
        <X402SetupStepHeaderIcon icon={Coins} />
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
            { icon: Link2, label: 'Select an EVM chain', delay: 'animate-delay-100' },
            { icon: WalletIcon, label: 'Configure how you receive', delay: 'animate-delay-125' },
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

  const chainScreen = (
    <X402ChainSelectionStep
      networkType={networkType}
      chains={envChains}
      selectedChain={selectedChain}
      isAddSourceMode={isAddSourceMode}
      isSelectedChainReady={selectedChainIsReady}
      isCreatingChain={isCreatingChain}
      isEditorOpen={isChainEditorOpen}
      chainEditor={
        isCreatingChain || isChainEditorOpen ? (
          <ChainForm
            key={isCreatingChain ? 'new' : (chainToConfigure?.id ?? 'none')}
            editing={isCreatingChain ? null : chainToConfigure}
            defaultFacilitatorMode={receivingMode}
            lockEnvironment
            onClose={() => {
              setIsCreatingChain(false);
              setIsChainEditorOpen(false);
            }}
            onSaved={(chain) => {
              setSavedChain(chain);
              setSelectedX402ChainId(chain.id);
              setIsCreatingChain(false);
              setIsChainEditorOpen(false);
              invalidate();
            }}
          />
        ) : null
      }
      onSelectChain={(chainId) => {
        setSelectedX402ChainId(chainId);
        setIsCreatingChain(false);
        setIsChainEditorOpen(false);
      }}
      onAddCustom={() => {
        setIsCreatingChain(true);
        setIsChainEditorOpen(true);
      }}
      onEditorOpenChange={setIsChainEditorOpen}
      onBack={() => (isAddSourceMode ? router.push('/payment-sources') : setCurrentStep(0))}
      onContinue={() => {
        if (selectedChain) setSelectedX402ChainId(selectedChain.id);
        if (isAddSourceMode && selectedChainIsReady) {
          finish();
          return;
        }
        setCurrentStep(2);
      }}
    />
  );

  const receivingScreen = (
    <div className="mx-auto w-full max-w-lg">
      <div className="text-center">
        <X402SetupStepHeaderIcon icon={Link2} />
        <h1 className="text-2xl font-bold tracking-tight">Enable receiving payments</h1>
        <p className="mx-auto mt-2 max-w-md text-sm text-muted-foreground">
          Choose local settlement with a managed Selling wallet, or use a remote facilitator.
        </p>
      </div>

      <div className="mt-6 grid grid-cols-2 gap-2">
        {(
          [
            {
              value: 'managed',
              title: 'Managed wallet',
              description: 'This service signs settlements with your Selling wallet.',
            },
            {
              value: 'remote',
              title: 'Remote facilitator',
              description: 'An external HTTPS service verifies and settles payments.',
            },
          ] as const
        ).map((option) => (
          <button
            key={option.value}
            type="button"
            aria-pressed={receivingMode === option.value}
            onClick={() => setReceivingMode(option.value)}
            className={cn(
              'rounded-lg border p-3 text-left transition-colors',
              receivingMode === option.value
                ? 'border-primary bg-primary/5 ring-1 ring-primary/30'
                : 'hover:bg-muted/40',
            )}
          >
            <span className="block text-sm font-medium">{option.title}</span>
            <span className="mt-1 block text-xs leading-snug text-muted-foreground">
              {option.description}
            </span>
          </button>
        ))}
      </div>

      <Card
        className={cn(
          'mt-6 space-y-4 p-5 text-center',
          isReceivingReadyConfirmed && 'border-green-500/20 bg-green-500/[0.04]',
        )}
      >
        {receivingMode === 'managed' && walletChips('Selling')}
        {isReceivingReadyConfirmed && selectedChain ? (
          <p className="flex items-center justify-center gap-1.5 text-sm text-green-600 dark:text-green-500">
            <CheckCircle2 className="h-4 w-4" /> Receiving is configured on{' '}
            {selectedChain.displayName}
          </p>
        ) : (
          <p className="text-xs text-muted-foreground">
            {receivingMode === 'managed'
              ? selectedSellingWallets.length > 0
                ? 'Assign your Selling wallet and enable the chain.'
                : 'Create a Selling wallet on this chain, then assign it as facilitator.'
              : 'Enter the remote facilitator URL and enable the chain.'}
          </p>
        )}
        <Button
          variant={isReceivingReadyConfirmed ? 'outline' : 'default'}
          className="gap-2"
          onClick={() => {
            if (receivingMode === 'managed' && selectedSellingWallets.length === 0) {
              openWalletDialog('Selling');
              return;
            }
            setIsCreatingChain(false);
            setIsChainEditorOpen(true);
            setCurrentStep(1);
          }}
        >
          {isReceivingReadyConfirmed
            ? 'Manage receiving'
            : receivingMode === 'managed' && selectedSellingWallets.length === 0
              ? 'Create selling wallet'
              : 'Configure facilitator'}
        </Button>
      </Card>

      {readinessUnavailable && (
        <div className="mt-3 flex items-center justify-between rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 text-xs">
          <span>Setup status is unavailable. Ready cannot be confirmed yet.</span>
          <Button variant="outline" size="sm" onClick={() => refetchReadiness()}>
            Retry
          </Button>
        </div>
      )}

      <div className="flex items-center justify-between pt-6">
        <Button variant="ghost" onClick={() => setCurrentStep(1)}>
          Back
        </Button>
        <Button
          className="btn-hover-lift group gap-2"
          disabled={!isReceivingReadyConfirmed}
          title={
            isReceivingReadyConfirmed
              ? undefined
              : (facilitatorDetail ?? 'Assign a chain facilitator to continue')
          }
          onClick={() => (isAddSourceMode ? finish() : setCurrentStep(3))}
        >
          {isAddSourceMode ? 'Finish' : 'Continue'}{' '}
          <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-1" />
        </Button>
      </div>
    </div>
  );

  const payingScreen = (
    <div className="mx-auto w-full max-w-lg">
      <div className="text-center">
        <X402SetupStepHeaderIcon icon={Coins} />
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
          selectedChainHasBudget && 'border-green-500/20 bg-green-500/[0.04]',
        )}
      >
        {walletChips('Purchasing')}
        {selectedChainHasBudget ? (
          <p className="flex items-center justify-center gap-1.5 text-sm text-green-600 dark:text-green-500">
            <CheckCircle2 className="h-4 w-4" /> Spend budget configured
          </p>
        ) : (
          <p className="text-xs text-muted-foreground">
            {selectedPurchasingWallets.length > 0
              ? 'Grant an API key a spend budget on your Purchasing wallet.'
              : 'Create a Purchasing wallet to fund outbound payments.'}
          </p>
        )}
        <Button
          variant={selectedChainHasBudget ? 'outline' : 'default'}
          className="gap-2"
          onClick={() =>
            selectedPurchasingWallets.length > 0
              ? setOpenDialog('budget')
              : openWalletDialog('Purchasing')
          }
        >
          {selectedPurchasingWallets.length === 0
            ? 'Create purchasing wallet'
            : selectedChainHasBudget
              ? 'Manage budgets'
              : 'Set budget'}
        </Button>
      </Card>

      <div className="flex items-center justify-between pt-6">
        <Button variant="ghost" onClick={() => setCurrentStep(2)}>
          Back
        </Button>
        <Button className="btn-hover-lift group gap-2" onClick={() => setCurrentStep(4)}>
          {selectedChainHasBudget ? 'Continue' : 'Skip for now'}
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
          {isReceivingReadyConfirmed ? 'x402 is ready' : 'Setup saved'}
        </CardTitle>
        <CardDescription className="mt-2 animate-fade-in-up text-base animate-delay-100">
          {isReceivingReadyConfirmed ? (
            <>
              Your <span className="font-medium text-foreground">{networkType}</span> EVM rail is
              ready to use
            </>
          ) : (
            'The setup status is unavailable. Check Payment Sources before receiving payments.'
          )}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6 pb-8">
        <div className="space-y-3">
          {[
            {
              label: 'Receiving payments enabled',
              done: isReceivingReadyConfirmed,
              optional: false,
            },
            {
              label: selectedChainHasBudget
                ? 'Outbound payments enabled'
                : 'Outbound payments skipped',
              done: selectedChainHasBudget,
              optional: false,
            },
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

  const steps = [welcomeScreen, chainScreen, receivingScreen, payingScreen, successScreen];

  // ---- Shell -----------------------------------------------------------------------------

  const activeStepLabels = isAddSourceMode ? ADD_SOURCE_STEP_LABELS : STEP_LABELS;
  const totalSteps = activeStepLabels.length;
  const showStepper = currentStep > 0 && currentStep < totalSteps - 1;
  const stepperSteps = activeStepLabels.slice(1, -1);

  return (
    <div className="mx-auto w-full max-w-2xl px-4">
      {showStepper && (
        <div className="mb-8 animate-fade-in">
          <div className="mb-4 flex items-center justify-between">
            <div>
              <p className="text-sm font-medium">{activeStepLabels[currentStep]}</p>
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
        defaultNetworkId={selectedChain?.id}
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
        defaultWalletId={selectedPurchasingWallets[0]?.id}
        onClose={() => setOpenDialog(null)}
        onSaved={() => {
          setOpenDialog(null);
          invalidate();
        }}
      />
    </div>
  );
}
