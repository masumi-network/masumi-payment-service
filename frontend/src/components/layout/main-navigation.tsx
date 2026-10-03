import type { LucideIcon } from 'lucide-react';
import {
  AlertTriangle,
  Bell,
  Bot,
  Code,
  FileText,
  GitBranch,
  Key,
  LayoutDashboard,
  MessageSquare,
  Receipt,
  Wallet,
  Wand2,
} from 'lucide-react';
import type { ActiveRail } from '@/lib/contexts/AppContext';

export type NavItem = {
  href: string;
  name: string;
  icon: LucideIcon;
  iconClassName?: string;
  badge: string | null;
  group: number;
  beta?: boolean;
  notificationDot?: boolean;
  notificationLabel?: string;
};

type MainNavigationOptions = {
  activeRail: ActiveRail;
  canAdmin: boolean;
  canPay: boolean;
  canShowHydraNav: boolean;
  hasPaymentSources: boolean;
  isSetupMode: boolean;
  isX402Standalone: boolean;
  setupHref: '/setup' | '/x402-setup';
  transactionBadge: string | null;
  walletAlertCount: number;
  walletAlertLabel?: string;
};

function accountItems(canAdmin: boolean): NavItem[] {
  return [
    ...(canAdmin
      ? [
          {
            href: '/api-keys',
            name: 'API keys',
            icon: Key,
            badge: null,
            group: 1,
          } satisfies NavItem,
        ]
      : []),
    {
      href: '/developers',
      name: 'Developers',
      icon: Code,
      iconClassName: 'text-violet-500',
      badge: null,
      group: 1,
    },
  ];
}

function setupItems(options: MainNavigationOptions): NavItem[] {
  const items: NavItem[] = [];

  if (options.canAdmin) {
    items.push({
      href: options.setupHref,
      name: 'Setup',
      icon: Wand2,
      badge: null,
      group: 0,
    });
    items.push({
      href: '/api-keys',
      name: 'API keys',
      icon: Key,
      badge: null,
      group: 1,
    });
  }
  if (options.canPay) {
    items.push({
      href: '/webhooks',
      name: 'Webhooks',
      icon: Bell,
      badge: null,
      group: 1,
    });
  }
  items.push({
    href: '/developers',
    name: 'Developers',
    icon: Code,
    iconClassName: 'text-violet-500',
    badge: null,
    group: 1,
  });

  return items;
}

function x402Items(options: MainNavigationOptions): NavItem[] {
  return [
    {
      href: '/x402/dashboard',
      name: 'Dashboard',
      icon: LayoutDashboard,
      badge: null,
      group: 0,
    },
    {
      href: '/ai-agents',
      name: 'AI Agents',
      icon: Bot,
      badge: null,
      group: 0,
    },
    {
      href: '/x402/wallets',
      name: 'Wallets',
      icon: Wallet,
      badge: null,
      group: 0,
    },
    {
      href: '/x402/payments',
      name: 'Transactions',
      icon: FileText,
      badge: null,
      group: 0,
    },
    ...(options.canPay
      ? [
          {
            href: '/webhooks',
            name: 'Webhooks',
            icon: Bell,
            badge: null,
            group: 0,
          } satisfies NavItem,
        ]
      : []),
    ...accountItems(options.canAdmin),
  ];
}

function cardanoItems(options: MainNavigationOptions): NavItem[] {
  return [
    {
      href: '/',
      name: 'Dashboard',
      icon: LayoutDashboard,
      badge: null,
      group: 0,
    },
    {
      href: '/ai-agents',
      name: 'AI Agents',
      icon: Bot,
      badge: null,
      group: 0,
    },
    {
      href: '/inbox-agents',
      name: 'Inbox Agents',
      icon: MessageSquare,
      badge: null,
      group: 0,
    },
    {
      href: '/wallets',
      name: 'Wallets',
      icon: Wallet,
      badge: null,
      group: 0,
      notificationDot: options.walletAlertCount > 0,
      notificationLabel: options.walletAlertLabel,
    },
    {
      href: '/transactions',
      name: 'Transactions',
      icon: FileText,
      badge: options.transactionBadge,
      group: 0,
    },
    ...(options.canAdmin && options.canShowHydraNav
      ? [
          {
            href: '/hydra-heads',
            name: 'Hydra',
            icon: GitBranch,
            badge: null,
            beta: true,
            group: 0,
          } satisfies NavItem,
        ]
      : []),
    ...(options.canAdmin
      ? [
          {
            href: '/tx-sync-quarantine',
            name: 'Sync Quarantine',
            icon: AlertTriangle,
            badge: null,
            group: 0,
          } satisfies NavItem,
        ]
      : []),
    {
      href: '/invoices',
      name: 'Invoices',
      icon: Receipt,
      badge: null,
      group: 0,
    },
    ...(options.canPay
      ? [
          {
            href: '/webhooks',
            name: 'Webhooks',
            icon: Bell,
            badge: null,
            group: 0,
          } satisfies NavItem,
        ]
      : []),
    ...accountItems(options.canAdmin),
  ];
}

export function buildMainNavigation(options: MainNavigationOptions): NavItem[] {
  if (options.isSetupMode || (!options.hasPaymentSources && !options.isX402Standalone)) {
    return setupItems(options);
  }

  return options.activeRail === 'x402' ? x402Items(options) : cardanoItems(options);
}
