import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ArrowRight, CheckCircle2, ChevronDown, Coins, Link2, Wallet } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import { useX402Budgets, useX402Networks, useX402Wallets } from '@/lib/hooks/useX402';
import { X402Network } from '@/lib/api/generated';
import { CreateWalletDialog } from './WalletsTab';
import { ChainDialog } from './ChainsTab';
import { BudgetDialog } from './BudgetsTab';

type DialogKind = 'wallet' | 'chain' | 'budget' | null;

/**
 * First-run onboarding for the x402 EVM rail.
 *
 * Shown above the tabs while the rail is not yet usable. Setup has a strict order
 * (wallet → facilitator/budget), which is easy to get wrong when the tabs are
 * presented as peers, so this guide computes each step's state from live data and
 * gates the later actions until a managed wallet exists. It reuses the same dialogs
 * the tabs use, so there is no second source of truth for creating these records.
 *
 * It hides itself once a wallet plus at least one capability (facilitator or budget)
 * exists — i.e. the rail can actually do something — or when collapsed by the user.
 */
export function X402SetupGuide() {
  const queryClient = useQueryClient();
  const { wallets, isLoading: walletsLoading } = useX402Wallets();
  const { networks, isLoading: networksLoading } = useX402Networks();
  const { budgets, isLoading: budgetsLoading } = useX402Budgets();
  const [openDialog, setOpenDialog] = useState<DialogKind>(null);
  const [collapsed, setCollapsed] = useState(false);

  const loading = walletsLoading || networksLoading || budgetsLoading;
  const hasWallet = wallets.length > 0;
  const hasFacilitator = networks.some(
    (network) => network.isEnabled && !!network.facilitatorWalletId,
  );
  const hasBudget = budgets.length > 0;
  const completedCount = [hasWallet, hasFacilitator, hasBudget].filter(Boolean).length;
  // "Usable" = a wallet plus at least one side (facilitator for receiving, budget for
  // paying). We intentionally don't require both — an operator may only do one side.
  const usable = hasWallet && (hasFacilitator || hasBudget);

  // Avoid flashing an "incomplete" guide before data loads, and step aside once the
  // rail can actually do something.
  if (loading || usable) return null;

  // Prefer attaching a facilitator to an existing enabled chain — Base ships
  // preconfigured by the seed — and fall back to adding a brand new chain.
  const chainToConfigure: X402Network | null =
    networks.find((network) => network.isEnabled && !network.facilitatorWalletId) ??
    networks[0] ??
    null;

  const invalidate = (keys: string[][]) =>
    keys.forEach((queryKey) => queryClient.invalidateQueries({ queryKey }));

  const steps = [
    {
      done: hasWallet,
      icon: Wallet,
      title: 'Create a managed EVM wallet',
      body: 'Generates an EVM keypair (or import your own). The private key is encrypted at rest and never leaves the server. This wallet signs your outbound payments and settles inbound ones.',
      actionLabel: hasWallet ? 'Add another' : 'Create wallet',
      onAction: () => setOpenDialog('wallet'),
      disabled: false,
    },
    {
      done: hasFacilitator,
      icon: Link2,
      title: 'Enable a chain & assign a facilitator',
      body: 'Pick an EVM chain (Base is preconfigured) and assign your wallet as its facilitator, so it can settle inbound x402 payments to your agents — the sell side.',
      actionLabel: hasFacilitator ? 'Manage chains' : 'Configure chain',
      onAction: () => setOpenDialog('chain'),
      disabled: !hasWallet,
    },
    {
      done: hasBudget,
      icon: Coins,
      title: 'Fund a spend budget',
      body: 'Grant an API key a capped budget on a wallet and token so it can sign outbound payments to other x402 resources — the buy side. Optional if you only receive payments.',
      actionLabel: hasBudget ? 'Manage budgets' : 'Set budget',
      onAction: () => setOpenDialog('budget'),
      disabled: !hasWallet,
    },
  ];

  return (
    <Card className="border-primary/30 bg-primary/[0.03]">
      <div className="flex items-start justify-between gap-4 p-5">
        <div className="space-y-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <h2 className="text-base font-semibold">Set up the x402 EVM rail</h2>
            <span className="text-xs font-medium text-muted-foreground">
              {completedCount} of 3 complete
            </span>
          </div>
          <p className="max-w-2xl text-sm text-muted-foreground">
            The x402 rail lets your agents pay — and get paid by — other agents over EVM chains
            using stablecoins. Start by creating a managed wallet; it backs both sides.
          </p>
        </div>
        <Button
          variant="ghost"
          size="sm"
          aria-label={collapsed ? 'Expand setup guide' : 'Collapse setup guide'}
          onClick={() => setCollapsed((value) => !value)}
        >
          <ChevronDown className={cn('h-4 w-4 transition-transform', collapsed && '-rotate-90')} />
        </Button>
      </div>

      {!collapsed && (
        <div className="space-y-2 px-5 pb-5">
          {steps.map((step, index) => {
            const StepIcon = step.icon;
            return (
              <div
                key={step.title}
                className={cn(
                  'flex flex-col gap-3 rounded-lg border p-4 sm:flex-row sm:items-start',
                  step.done ? 'bg-muted/30' : 'bg-background',
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
              </div>
            );
          })}
        </div>
      )}

      <CreateWalletDialog
        key={openDialog === 'wallet' ? 'wallet-open' : 'wallet-closed'}
        open={openDialog === 'wallet'}
        onClose={() => setOpenDialog(null)}
        onSaved={() => {
          setOpenDialog(null);
          // A new wallet also becomes a selectable budget/facilitator target.
          invalidate([['x402-wallets'], ['x402-budgets']]);
        }}
      />
      <ChainDialog
        key={openDialog === 'chain' ? `chain-${chainToConfigure?.id ?? 'new'}` : 'chain-closed'}
        open={openDialog === 'chain'}
        editing={chainToConfigure}
        onClose={() => setOpenDialog(null)}
        onSaved={() => {
          setOpenDialog(null);
          invalidate([['x402-networks']]);
        }}
      />
      <BudgetDialog
        key={openDialog === 'budget' ? 'budget-open' : 'budget-closed'}
        open={openDialog === 'budget'}
        editing={null}
        onClose={() => setOpenDialog(null)}
        onSaved={() => {
          setOpenDialog(null);
          invalidate([['x402-budgets']]);
        }}
      />
    </Card>
  );
}
