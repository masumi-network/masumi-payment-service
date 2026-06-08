import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ArrowRight, CheckCircle2, ChevronDown, Coins, Link2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { cn, shortenAddress } from '@/lib/utils';
import { useAppContext } from '@/lib/contexts/AppContext';
import { useX402Budgets, useX402Networks, useX402Wallets } from '@/lib/hooks/useX402';
import { X402_ACCENT } from '@/lib/x402-rail';
import { X402Network, X402Wallet } from '@/lib/api/generated';
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
  const { apiClient, authorized } = useAppContext();
  const { wallets, isLoading: walletsLoading } = useX402Wallets();
  const { networks, isLoading: networksLoading } = useX402Networks();
  const { budgets, isLoading: budgetsLoading } = useX402Budgets();
  const [openDialog, setOpenDialog] = useState<DialogKind>(null);
  const [walletType, setWalletType] = useState<X402Wallet['type']>('Selling');
  const [collapsed, setCollapsed] = useState(false);

  const loading = walletsLoading || networksLoading || budgetsLoading;
  // Wallets are split by direction: a Selling wallet settles inbound payments (facilitator),
  // a Purchasing wallet funds outbound ones (budget). Each capability needs its own type.
  const hasSellingWallet = wallets.some((wallet) => wallet.type === 'Selling');
  const hasPurchasingWallet = wallets.some((wallet) => wallet.type === 'Purchasing');
  const hasFacilitator = networks.some(
    (network) => network.isEnabled && !!network.facilitatorWalletId,
  );
  const hasBudget = budgets.length > 0;
  const completedCount = [hasFacilitator, hasBudget].filter(Boolean).length;
  // "Usable" = at least one side works (facilitator for receiving, budget for paying).
  // We intentionally don't require both — an operator may only do one side.
  const usable = hasFacilitator || hasBudget;

  // Wait for auth before deciding anything: the x402 hooks return empty arrays while
  // disabled (unauthenticated), which would otherwise flash the guide on a fully
  // configured rail. Then avoid flashing during the real load, and step aside once the
  // rail can actually do something.
  if (!apiClient || !authorized || loading || usable) return null;

  // Prefer attaching a facilitator to an existing enabled chain — Base ships
  // preconfigured by the seed — and fall back to adding a brand new chain.
  const chainToConfigure: X402Network | null =
    networks.find((network) => network.isEnabled && !network.facilitatorWalletId) ??
    networks[0] ??
    null;
  const configuredChain = networks.find((n) => n.isEnabled && !!n.facilitatorWalletId) ?? null;

  const invalidate = (keys: string[][]) =>
    keys.forEach((queryKey) => queryClient.invalidateQueries({ queryKey }));

  const openWalletDialog = (type: X402Wallet['type']) => {
    setWalletType(type);
    setOpenDialog('wallet');
  };

  // Show the wallets the operator already has for a direction, so the guide reflects state
  // rather than re-asking them to create one.
  const walletChips = (type: X402Wallet['type']) => {
    const matching = wallets.filter((wallet) => wallet.type === type);
    if (matching.length === 0) return null;
    return (
      <div className="flex flex-wrap gap-1.5 pt-1.5">
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

  // Each step owns the wallet type it needs and shows what already exists, so there is no
  // confusing standalone "create a wallet" step that the next steps then re-demand.
  const steps = [
    {
      done: hasFacilitator,
      icon: Link2,
      title: 'Enable receiving payments',
      body: 'Create a Selling wallet and assign it as a chain facilitator (Base is preconfigured) so your agents can be paid over x402.',
      detail: (
        <>
          {walletChips('Selling')}
          {hasFacilitator && configuredChain && (
            <p className="pt-1.5 text-xs text-green-600 dark:text-green-500">
              Facilitator set on {configuredChain.displayName}.
            </p>
          )}
        </>
      ),
      actionLabel: !hasSellingWallet
        ? 'Create selling wallet'
        : hasFacilitator
          ? 'Manage chains'
          : 'Assign facilitator',
      onAction: () => (hasSellingWallet ? setOpenDialog('chain') : openWalletDialog('Selling')),
    },
    {
      done: hasBudget,
      icon: Coins,
      title: 'Enable outbound payments',
      body: 'Create a Purchasing wallet and grant an API key a capped budget so it can pay other x402 resources. Optional if you only receive payments.',
      detail: walletChips('Purchasing'),
      actionLabel: !hasPurchasingWallet
        ? 'Create purchasing wallet'
        : hasBudget
          ? 'Manage budgets'
          : 'Set budget',
      onAction: () =>
        hasPurchasingWallet ? setOpenDialog('budget') : openWalletDialog('Purchasing'),
    },
  ];

  return (
    <Card className="border-primary/30 bg-primary/[0.03]">
      <div className="flex items-start justify-between gap-4 p-5">
        <div className="space-y-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <h2 className="text-base font-semibold">Set up the x402 EVM rail</h2>
            <span className="text-xs font-medium text-muted-foreground">
              {completedCount} of 2 complete
            </span>
          </div>
          <p className="max-w-2xl text-sm text-muted-foreground">
            The x402 rail lets your agents pay — and get paid by — other agents over EVM chains
            using stablecoins. Create a Selling wallet to receive payments and a Purchasing wallet
            to send them.
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
                  'flex flex-col gap-3 rounded-lg border p-4 transition-colors sm:flex-row sm:items-start',
                  step.done
                    ? 'border-green-500/20 bg-green-500/[0.04]'
                    : 'bg-background hover:border-primary/30',
                )}
              >
                <div className="mt-0.5 shrink-0">
                  {step.done ? (
                    <CheckCircle2 className="h-7 w-7 text-green-600 dark:text-green-500" />
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
                  {step.detail}
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
              </div>
            );
          })}
        </div>
      )}

      <CreateWalletDialog
        key={openDialog === 'wallet' ? `wallet-open-${walletType}` : 'wallet-closed'}
        open={openDialog === 'wallet'}
        defaultType={walletType}
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
