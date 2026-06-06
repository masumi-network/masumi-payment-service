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
import { X402Network } from '@/lib/api/generated';
import { CreateWalletDialog } from '@/components/x402/WalletsTab';
import { ChainDialog } from '@/components/x402/ChainsTab';
import { BudgetDialog } from '@/components/x402/BudgetsTab';

/** Three-stage progress indicator: Welcome → Configure → Ready. */
function WizardProgress({ current }: { current: 1 | 2 | 3 }) {
  const labels = ['Welcome', 'Configure', 'Ready'];
  return (
    <div className="mx-auto mb-6 flex max-w-xs items-center gap-2">
      {labels.map((label, index) => {
        const step = index + 1;
        const done = step < current;
        const active = step === current;
        return (
          <Fragment key={label}>
            <div
              className={cn(
                'flex h-6 w-6 items-center justify-center rounded-full text-xs font-semibold transition-colors',
                done
                  ? 'bg-green-500 text-white'
                  : active
                    ? 'bg-primary text-primary-foreground'
                    : 'border-2 border-muted-foreground/30 text-muted-foreground',
              )}
              title={label}
            >
              {done ? <Check className="h-3 w-3" /> : step}
            </div>
            {step < 3 && (
              <div className={cn('h-0.5 flex-1 rounded', done ? 'bg-green-500' : 'bg-muted')} />
            )}
          </Fragment>
        );
      })}
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

  // The x402 hooks are disabled (and return []) until authorized, which would otherwise
  // read as "nothing configured". Treat the pre-auth window as loading so step state and
  // finish() never act on empty data.
  const loading = !authorized || walletsLoading || networksLoading || budgetsLoading;

  const envChains = useMemo(() => chainsForEnv(networks, networkType), [networks, networkType]);
  const hasWallet = wallets.length > 0;
  const hasFacilitator = envChains.some((chain) => !!chain.facilitatorWalletId);
  const hasBudget = budgets.length > 0;

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
      body: 'Generates an EVM keypair (or import your own). The private key is encrypted at rest and never leaves the server. This wallet signs outbound payments and settles inbound ones.',
      actionLabel: hasWallet ? 'Add another wallet' : 'Create wallet',
      onAction: () => setOpenDialog('wallet'),
      disabled: false,
    },
    {
      done: hasFacilitator,
      icon: Link2,
      title: 'Enable a chain & assign a facilitator',
      body: `Pick an EVM chain for ${networkType} (Base is preconfigured) and assign your wallet as its facilitator so it can settle inbound x402 payments — the sell side.`,
      actionLabel: hasFacilitator ? 'Manage chain' : 'Configure chain',
      onAction: () => setOpenDialog('chain'),
      disabled: !hasWallet,
    },
    {
      done: hasBudget,
      icon: Coins,
      title: 'Fund a spend budget (optional)',
      body: 'Grant an API key a capped budget on a wallet and token so it can sign outbound payments to other x402 resources — the buy side. Skip if you only receive payments.',
      actionLabel: hasBudget ? 'Manage budgets' : 'Set budget',
      onAction: () => setOpenDialog('budget'),
      disabled: !hasWallet,
      optional: true,
    },
  ];

  // ---- Welcome screen --------------------------------------------------------------
  if (currentStep === 0) {
    return (
      <div className="mx-auto max-w-2xl px-4">
        <WizardProgress current={1} />
        <Card className="border-indigo-300/40 bg-gradient-to-br from-indigo-50/60 to-background p-8 text-center dark:border-indigo-900/40 dark:from-indigo-950/20">
          <div className="mx-auto mb-5 flex h-14 w-14 items-center justify-center rounded-2xl bg-indigo-500/15 ring-1 ring-indigo-500/30">
            <Coins className={cn('h-7 w-7', X402_ACCENT.icon)} />
          </div>
          <div className="mb-2 flex items-center justify-center gap-2">
            <h1 className="text-2xl font-semibold tracking-tight">Set up the x402 (EVM) rail</h1>
            <Badge variant="outline" className="font-medium">
              EVM
            </Badge>
            <Badge variant="secondary" className="font-medium">
              {networkType}
            </Badge>
          </div>
          <p className="mx-auto mb-6 max-w-lg text-sm text-muted-foreground">
            Let your agents pay — and get paid by — other agents over EVM chains using stablecoins.
            This quick setup creates a managed wallet, enables a chain, and (optionally) funds a
            spend budget.
          </p>
          <div className="mb-8 grid gap-3 sm:grid-cols-3">
            {[
              { icon: WalletIcon, label: 'Managed wallet' },
              { icon: Link2, label: 'Enabled chain' },
              { icon: Sparkles, label: 'Ready to transact' },
            ].map((feature) => (
              <div
                key={feature.label}
                className="flex flex-col items-center gap-2 rounded-lg border bg-background/60 p-4"
              >
                <feature.icon className={cn('h-5 w-5', X402_ACCENT.icon)} />
                <span className="text-xs font-medium text-muted-foreground">{feature.label}</span>
              </div>
            ))}
          </div>
          <Button size="lg" className="gap-2" onClick={() => setCurrentStep(1)}>
            Get started
            <ArrowRight className="h-4 w-4" />
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
        <Card className="p-8 text-center">
          <div className="mx-auto mb-5 flex h-14 w-14 items-center justify-center rounded-2xl bg-green-500/15 ring-1 ring-green-500/30">
            <CheckCircle2 className="h-7 w-7 text-green-600 dark:text-green-500" />
          </div>
          <h1 className="mb-2 text-2xl font-semibold tracking-tight">x402 is ready</h1>
          <p className="mx-auto mb-6 max-w-lg text-sm text-muted-foreground">
            The EVM rail is configured for {networkType}. You can manage chains, wallets, budgets
            and payments any time from the x402 page.
          </p>
          <div className="mx-auto mb-8 max-w-sm space-y-2 text-left">
            {steps.map((step) => (
              <div key={step.title} className="flex items-center gap-2 text-sm">
                <CheckCircle2
                  className={cn(
                    'h-4 w-4 shrink-0',
                    step.done ? 'text-green-600 dark:text-green-500' : 'text-muted-foreground/40',
                  )}
                />
                <span className={cn(!step.done && 'text-muted-foreground')}>
                  {step.title}
                  {step.optional && !step.done ? ' — skipped' : ''}
                </span>
              </div>
            ))}
          </div>
          <Button size="lg" className="gap-2" onClick={finish}>
            Go to x402
            <ArrowRight className="h-4 w-4" />
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
                className={cn(
                  'flex flex-col gap-3 p-4 sm:flex-row sm:items-start',
                  step.done && 'bg-muted/30',
                )}
              >
                <div className="mt-0.5 shrink-0">
                  {step.done ? (
                    <CheckCircle2 className="h-6 w-6 text-green-600 dark:text-green-500" />
                  ) : (
                    <div className="flex h-6 w-6 items-center justify-center rounded-full border-2 border-muted-foreground/30 text-xs font-semibold text-muted-foreground">
                      {index + 1}
                    </div>
                  )}
                </div>
                <div className="flex-1 space-y-1">
                  <div className="flex items-center gap-2">
                    <StepIcon className="h-4 w-4 text-muted-foreground" />
                    <p className={cn('text-sm font-medium', step.done && 'text-muted-foreground')}>
                      {step.title}
                    </p>
                  </div>
                  <p className="text-xs text-muted-foreground">{step.body}</p>
                </div>
                <Button
                  variant={step.done ? 'outline' : 'default'}
                  size="sm"
                  className="shrink-0 self-start"
                  disabled={step.disabled}
                  onClick={step.onAction}
                  title={step.disabled ? 'Create a managed wallet first' : undefined}
                >
                  {step.actionLabel}
                  {!step.done && <ArrowRight className="ml-1 h-3.5 w-3.5" />}
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
        key={openDialog === 'wallet' ? 'wallet-open' : 'wallet-closed'}
        open={openDialog === 'wallet'}
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
