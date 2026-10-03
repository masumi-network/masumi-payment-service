import type { ReactNode } from 'react';
import { ArrowRight, Bot, Check, CheckCircle2, Coins, Download, Fuel, Link2 } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader } from '@/components/ui/card';
import type { X402SetupController } from '@/components/x402/setup/useX402SetupController';
import type { NetworkType } from '@/lib/contexts/AppContext';
import { cn, shortenAddress } from '@/lib/utils';
import { X402_ACCENT } from '@/lib/x402-rail';
import { X402_SETUP_STEPS } from '@/lib/x402-setup';

const STAGGER_CLASSES = ['', '[animation-delay:100ms]', '[animation-delay:200ms]'];

function staggerClass(index: number) {
  return STAGGER_CLASSES[index] ?? '[animation-delay:300ms]';
}

function EndScreenIcon({
  children,
  isSuccess = false,
}: {
  children: ReactNode;
  isSuccess?: boolean;
}) {
  return (
    <div
      className={cn(
        'mx-auto mb-6 flex size-16 items-center justify-center rounded-full bg-gradient-to-br ring-1',
        isSuccess ? 'from-green-500/20 to-green-600/10 ring-green-500/30' : X402_ACCENT.iconRing,
      )}
    >
      {children}
    </div>
  );
}

function PrimaryCta({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <Button onClick={onClick} size="lg" className="group h-11 w-full gap-2 pe-3.5 text-base">
      {label}
      <ArrowRight
        className="size-4 transition-[translate] duration-150 group-hover:translate-x-0.5"
        aria-hidden
      />
    </Button>
  );
}

/** Welcome: what setup covers, with the parts already done ticked off. */
export function X402WelcomeScreen({
  networkType,
  controller,
}: {
  networkType: NetworkType;
  controller: X402SetupController;
}) {
  const { selectedChain, isReceivingReady, purchasingWallets, goToStep } = controller;
  const items = [
    { icon: Link2, label: 'Choose an EVM chain', isDone: !!selectedChain && isReceivingReady },
    { icon: Download, label: 'Receive payments', isDone: isReceivingReady },
    {
      icon: Coins,
      label: 'Pay other agents (optional)',
      isDone: purchasingWallets.length > 0,
    },
  ];
  const hasProgress = items.some((item) => item.isDone);

  return (
    <Card className="mx-auto w-full max-w-lg animate-scale-in-bounce border bg-gradient-to-b from-card to-card/80 shadow-xl">
      <CardHeader className="pb-4 pt-8 text-center">
        <EndScreenIcon>
          <Coins className={cn('size-8', X402_ACCENT.icon)} aria-hidden />
        </EndScreenIcon>
        <h1 className="text-balance text-3xl font-bold leading-tight tracking-tight outline-none">
          Set up x402 payments
        </h1>
        <CardDescription className="mt-2 text-pretty text-base">
          Let your agents get paid, and pay other agents, in stablecoins on EVM chains. Setup
          applies to <span className="font-medium text-foreground">{networkType}</span>.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6 pb-8">
        <ol className="space-y-3">
          {items.map((item, index) => (
            <li
              key={item.label}
              style={{ animationFillMode: 'forwards' }}
              className={cn(
                'flex animate-slide-in-left items-center gap-3 rounded-lg border bg-muted/30 px-4 py-3 opacity-0',
                staggerClass(index),
              )}
            >
              <span className="flex size-9 items-center justify-center rounded-full bg-indigo-500/10">
                <item.icon className={cn('size-4', X402_ACCENT.icon)} aria-hidden />
              </span>
              <span className="flex-1 text-sm font-medium">{item.label}</span>
              {item.isDone && (
                <span className="flex items-center gap-1 text-xs font-medium text-green-700 dark:text-green-500">
                  <Check className="size-3.5" aria-hidden />
                  Done
                </span>
              )}
            </li>
          ))}
        </ol>
        <PrimaryCta
          label={hasProgress ? 'Continue setup' : 'Get started'}
          onClick={() => goToStep(X402_SETUP_STEPS.chain)}
        />
      </CardContent>
    </Card>
  );
}

/** Ready: what was set up and the few things left to do outside the wizard. */
export function X402ReadyScreen({ controller }: { controller: X402SetupController }) {
  const {
    selectedChain,
    isReceivingReady,
    isAddSourceMode,
    isReadinessUnavailable,
    facilitatorWallet,
    purchasingWallets,
    finish,
  } = controller;
  if (!selectedChain) return null;

  const isNodeMode = !selectedChain.facilitatorUrl;
  const sellingAddress = facilitatorWallet?.address ?? selectedChain.facilitatorWalletAddress;
  const rows = [
    { label: 'Chain', value: selectedChain.displayName },
    {
      label: 'Receiving',
      value: isReceivingReady
        ? isNodeMode
          ? 'On, settled by your Selling wallet'
          : 'On, settled by a remote facilitator'
        : 'Not enabled',
    },
    ...(isAddSourceMode
      ? []
      : [
          {
            label: 'Paying',
            value:
              purchasingWallets.length > 0
                ? `${purchasingWallets.length} Purchasing wallet${purchasingWallets.length === 1 ? '' : 's'}`
                : 'Skipped',
          },
        ]),
  ];
  const nextSteps = [
    ...(isReceivingReady && isNodeMode && sellingAddress
      ? [
          {
            icon: Fuel,
            text: (
              <>
                Send some of the chain&apos;s gas token to your Selling wallet{' '}
                <span className="font-mono text-xs">{shortenAddress(sellingAddress, 6)}</span> for
                settlement gas.
              </>
            ),
          },
        ]
      : []),
    {
      icon: Bot,
      text: 'Register an agent with an x402 payment option so buyers can pay it.',
    },
  ];

  return (
    <Card className="relative mx-auto w-full max-w-lg animate-scale-in-bounce overflow-hidden border bg-gradient-to-b from-card to-card/80 shadow-xl">
      <CardHeader className="pb-4 pt-10 text-center">
        <EndScreenIcon isSuccess>
          <CheckCircle2 className="size-8 text-green-700 dark:text-green-500" aria-hidden />
        </EndScreenIcon>
        <h1 className="text-balance text-3xl font-bold leading-tight tracking-tight outline-none">
          {isReceivingReady ? 'x402 is ready' : 'Setup saved'}
        </h1>
        <CardDescription className="mt-2 text-pretty text-base">
          {isReceivingReady
            ? `Your agents can take x402 payments on ${selectedChain.displayName}.`
            : 'Receiving is not on yet. Enable it before agents take payments.'}
        </CardDescription>
        {isReadinessUnavailable && (
          <Badge variant="warning" className="mx-auto mt-3">
            Setup status could not be checked
          </Badge>
        )}
      </CardHeader>
      <CardContent className="space-y-6 pb-8">
        <dl className="divide-y rounded-lg border text-sm">
          {rows.map((row) => (
            <div key={row.label} className="flex items-center justify-between gap-4 px-4 py-2.5">
              <dt className="text-muted-foreground">{row.label}</dt>
              <dd className="text-end font-medium">{row.value}</dd>
            </div>
          ))}
        </dl>
        <div className="space-y-2">
          <h2 className="text-sm font-medium">Next steps</h2>
          <ul className="space-y-2">
            {nextSteps.map((step, index) => (
              <li
                key={index}
                className="flex items-start gap-3 rounded-lg border bg-muted/30 px-4 py-3 text-pretty text-sm"
              >
                <step.icon className={cn('mt-0.5 size-4 shrink-0', X402_ACCENT.icon)} aria-hidden />
                <span>{step.text}</span>
              </li>
            ))}
          </ul>
        </div>
        <div className="space-y-2">
          <PrimaryCta label="Open x402 dashboard" onClick={() => finish()} />
          <Button variant="ghost" className="w-full" onClick={() => finish('/ai-agents')}>
            Register an agent
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
