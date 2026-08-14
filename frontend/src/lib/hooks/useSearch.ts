import { useCallback, useMemo } from 'react';
import { usePaymentSourceExtendedAll } from './usePaymentSourceExtendedAll';
import { useAllWallets } from '../queries/useWallets';
import { useAppContext } from '../contexts/AppContext';
import { getWalletTypeTitleLabel } from '../wallet-type';

export interface SearchableItem {
  id: string;
  title: string;
  description?: string;
  type: 'page' | 'action' | 'wallet' | 'agent' | 'payment-source' | 'transaction';
  href: string;
  keywords?: string[];
  elementId?: string;
  /**
   * Capability this entry needs. The palette is a second route into every page
   * and quick action, so without this a read-only key could search its way to a
   * surface the nav hides and the router bounces.
   */
  requires?: 'pay' | 'admin';
}

const searchableItems: SearchableItem[] = [
  { id: 'dashboard', title: 'Dashboard', type: 'page', href: '/' },
  { id: 'ai-agents', title: 'AI Agents', type: 'page', href: '/ai-agents' },
  { id: 'inbox-agents', title: 'Inbox Agents', type: 'page', href: '/inbox-agents' },
  { id: 'wallets', title: 'Wallets', type: 'page', href: '/wallets' },
  {
    id: 'transactions',
    title: 'Transactions',
    type: 'page',
    href: '/transactions',
  },
  {
    id: 'payment-sources',
    title: 'Payment Sources',
    type: 'page',
    href: '/payment-sources',
    requires: 'admin',
  },
  { id: 'api-keys', title: 'API Keys', type: 'page', href: '/api-keys', requires: 'admin' },
  { id: 'webhooks', title: 'Webhooks', type: 'page', href: '/webhooks', requires: 'pay' },
  { id: 'settings', title: 'Settings', type: 'page', href: '/settings' },

  {
    id: 'add-ai-agent',
    title: 'Add AI Agent',
    type: 'action',
    href: '/ai-agents?action=register_agent',
    elementId: 'add-ai-agent-button',
    requires: 'pay',
    keywords: ['create agent', 'new agent'],
  },
  {
    id: 'add-inbox-agent',
    title: 'Add Inbox Agent',
    type: 'action',
    href: '/inbox-agents?action=register_inbox_agent',
    elementId: 'add-inbox-agent-button',
    requires: 'pay',
    keywords: ['create inbox agent', 'new inbox agent', 'register inbox'],
  },
  {
    id: 'add-wallet',
    title: 'Add Wallet',
    type: 'action',
    href: '/wallets?action=add_wallet',
    elementId: 'add-wallet-button',
    requires: 'admin',
    keywords: ['create wallet', 'new wallet'],
  },
  {
    id: 'add-payment-source',
    title: 'Add Payment Source',
    type: 'action',
    href: '/payment-sources?action=add_payment_source',
    elementId: 'add-payment-source-button',
    requires: 'admin',
    keywords: ['create payment source', 'new payment source'],
  },
  {
    id: 'add-api-key',
    title: 'Add API Key',
    type: 'action',
    href: '/api-keys?action=add_api_key',
    elementId: 'add-api-key-button',
    requires: 'admin',
    keywords: ['create api key', 'new api key'],
  },
  {
    id: 'add-webhook',
    title: 'Add Webhook',
    type: 'action',
    href: '/webhooks?action=add_webhook',
    elementId: 'add-webhook-button',
    requires: 'pay',
    keywords: ['create webhook', 'new webhook', 'slack alert', 'discord alert'],
  },
  {
    id: 'toggle-theme',
    title: 'Toggle Theme',
    description: 'Change between light and dark mode',
    type: 'action',
    href: '/settings',
    elementId: 'settings-theme-toggle',
    keywords: ['dark mode', 'light mode', 'theme', 'appearance'],
  },
  {
    id: 'notifications',
    title: 'Notifications',
    type: 'action',
    href: '/',
    elementId: 'notifications-button',
    keywords: ['alerts', 'messages'],
  },
  {
    id: 'incoming-transactions',
    title: 'Incoming Transactions',
    type: 'transaction',
    href: '/transactions?type=incoming',
    keywords: ['received', 'incoming payments'],
  },
  {
    id: 'outgoing-transactions',
    title: 'Outgoing Transactions',
    type: 'transaction',
    href: '/transactions?type=outgoing',
    keywords: ['sent', 'outgoing payments'],
  },
];

export function useSearch(enabled = true) {
  const { network, capabilities } = useAppContext();

  const { paymentSources } = usePaymentSourceExtendedAll();
  // Only load the full wallet set while the search UI is actually open — this
  // hook is mounted app-wide (MainLayout), so an unconditional fetch would
  // reintroduce the global wallet load on every page.
  const { wallets, isLoading: isWalletsLoading } = useAllWallets(enabled);

  const currentNetworkPaymentSources = useMemo(
    () => paymentSources.filter((ps) => ps.network === network),
    [paymentSources, network],
  );

  const allResults = useMemo(() => {
    const dynamicResults: SearchableItem[] = [];

    // Index wallets that belong to a payment source on the active network.
    // Wallets are no longer embedded in the source, so join by paymentSourceId.
    const currentNetworkSourceIds = new Set(
      currentNetworkPaymentSources.map((source) => source.id),
    );
    wallets.forEach((wallet) => {
      if (!currentNetworkSourceIds.has(wallet.paymentSourceId)) return;
      dynamicResults.push({
        id: wallet.walletAddress,
        title: getWalletTypeTitleLabel(wallet.type),
        description: (wallet.note ?? '') + ` Address: ${wallet.walletAddress}`,
        type: 'wallet',
        href: `/wallets?searched=${wallet.walletAddress}`,
        elementId: `wallet-${wallet.walletAddress}`,
      });
    });

    currentNetworkPaymentSources?.forEach((source) => {
      dynamicResults.push({
        id: source.id,
        title: 'Payment Source',
        description: `Contract: ${source.smartContractAddress}`,
        type: 'payment-source',
        href: `/payment-sources?searched=${source.id}`,
        elementId: `payment-source-${source.id}`,
        requires: 'admin',
      });
    });

    const permitted = (item: SearchableItem) =>
      item.requires === 'admin'
        ? capabilities.canAdmin
        : item.requires === 'pay'
          ? capabilities.canPay
          : true;

    return [...searchableItems, ...dynamicResults].filter(permitted);
  }, [currentNetworkPaymentSources, wallets, capabilities.canAdmin, capabilities.canPay]);

  const handleSearch = useCallback(
    async (query: string) => {
      if (!query.trim()) {
        return allResults;
      }

      const queryLower = query.toLowerCase();
      const filteredResults = allResults.filter(
        (item) =>
          item.title.toLowerCase().includes(queryLower) ||
          item.description?.toLowerCase().includes(queryLower) ||
          item.keywords?.some((keyword) => keyword.toLowerCase().includes(queryLower)),
      );

      return filteredResults;
    },
    [allResults],
  );

  return {
    handleSearch,
    // Wallets load lazily once the search UI opens; surface this so consumers can
    // signal that wallet matches may still be incoming.
    isWalletsLoading,
  };
}
