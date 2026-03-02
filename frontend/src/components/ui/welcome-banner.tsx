import { useState, useSyncExternalStore } from 'react';
import { cn } from '@/lib/utils';
import { X, CreditCard, Bot, Wallet, ArrowUpDown, Check } from 'lucide-react';
import Link from 'next/link';

interface WelcomeBannerProps {
  agentCount: number;
  walletCount: number;
  transactionCount: number;
  hasPaymentSource: boolean;
}

const DISMISSED_KEY = 'masumi_welcome_banner_dismissed';

function getSnapshot() {
  return localStorage.getItem(DISMISSED_KEY) === 'true';
}

function getServerSnapshot() {
  return true;
}

function subscribe(callback: () => void) {
  window.addEventListener('storage', callback);
  return () => window.removeEventListener('storage', callback);
}

export function WelcomeBanner({
  agentCount,
  walletCount,
  transactionCount,
  hasPaymentSource,
}: WelcomeBannerProps) {
  const isDismissedFromStorage = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  const [dismissed, setDismissed] = useState(false);

  const allDone = hasPaymentSource && agentCount > 0 && walletCount > 0 && transactionCount > 0;

  if (isDismissedFromStorage || dismissed || allDone) return null;

  const steps = [
    {
      label: 'Set up payment source',
      href: '/payment-sources',
      done: hasPaymentSource,
      icon: CreditCard,
    },
    {
      label: 'Register an AI agent',
      href: '/ai-agents?action=register_agent',
      done: agentCount > 0,
      icon: Bot,
    },
    {
      label: 'Fund a wallet',
      href: '/wallets',
      done: walletCount > 0,
      icon: Wallet,
    },
    {
      label: 'Make a transaction',
      href: '/transactions',
      done: transactionCount > 0,
      icon: ArrowUpDown,
    },
  ];

  const handleDismiss = () => {
    localStorage.setItem(DISMISSED_KEY, 'true');
    setDismissed(true);
  };

  return (
    <div className="border rounded-lg p-6 bg-muted/30 relative animate-fade-in-up opacity-0">
      <button
        onClick={handleDismiss}
        className="absolute top-4 right-4 text-muted-foreground hover:text-foreground transition-colors"
      >
        <X className="h-4 w-4" />
      </button>
      <h2 className="text-lg font-semibold tracking-tight mb-1">Welcome to Masumi</h2>
      <p className="text-sm text-muted-foreground mb-4">
        Get started by completing these steps to set up your payment service.
      </p>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
        {steps.map((step) => (
          <Link
            key={step.label}
            href={step.href}
            className={cn(
              'flex items-center gap-3 rounded-lg border p-3 transition-colors',
              step.done
                ? 'bg-muted/50 border-green-500/30'
                : 'hover:bg-muted/50 hover:border-primary/30',
            )}
          >
            <div
              className={cn(
                'flex items-center justify-center w-8 h-8 rounded-full shrink-0',
                step.done ? 'bg-green-500/15' : 'bg-muted',
              )}
            >
              {step.done ? (
                <Check className="h-4 w-4 text-green-500" />
              ) : (
                <step.icon className="h-4 w-4 text-muted-foreground" />
              )}
            </div>
            <span
              className={cn(
                'text-sm',
                step.done ? 'text-muted-foreground line-through' : 'font-medium',
              )}
            >
              {step.label}
            </span>
          </Link>
        ))}
      </div>
    </div>
  );
}
