import { useCallback, useMemo, useState } from 'react';
import { usePaymentSourceExtendedAll } from './usePaymentSourceExtendedAll';
import { PaymentSourceExtended } from '../api/generated';
import { useAppContext } from '../contexts/AppContext';

export interface SearchableItem {
  id: string;
  title: string;
  description?: string;
  type: 'page' | 'action' | 'wallet' | 'agent' | 'payment-source' | 'transaction';
  href: string;
  keywords?: string[];
  elementId?: string;
}

const searchableItems: SearchableItem[] = [
  { id: 'dashboard', title: 'Dashboard', type: 'page', href: '/' },
  { id: 'ai-agents', title: 'AI Agents', type: 'page', href: '/ai-agents' },
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
  },
  { id: 'api-keys', title: 'API Keys', type: 'page', href: '/api-keys' },
  { id: 'settings', title: 'Settings', type: 'page', href: '/settings' },

  {
    id: 'add-ai-agent',
    title: 'Add AI Agent',
    type: 'action',
    href: '/ai-agents?action=register_agent',
    elementId: 'add-ai-agent-button',
    keywords: ['create agent', 'new agent'],
  },
  {
    id: 'add-wallet',
    title: 'Add Wallet',
    type: 'action',
    href: '/wallets?action=add_wallet',
    elementId: 'add-wallet-button',
    keywords: ['create wallet', 'new wallet'],
  },
  {
    id: 'add-payment-source',
    title: 'Add Payment Source',
    type: 'action',
    href: '/payment-sources?action=add_payment_source',
    elementId: 'add-payment-source-button',
    keywords: ['create payment source', 'new payment source'],
  },
  {
    id: 'add-api-key',
    title: 'Add API Key',
    type: 'action',
    href: '/api-keys?action=add_api_key',
    elementId: 'add-api-key-button',
    keywords: ['create api key', 'new api key'],
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

export function useSearch() {
  const { network } = useAppContext();

  const { paymentSources } = usePaymentSourceExtendedAll();

  const currentNetworkPaymentSources = useMemo(
    () => paymentSources.filter((ps) => ps.network === network),
    [paymentSources, network],
  );

  const allResults = useMemo(() => {
    const dynamicResults: SearchableItem[] = [];

    currentNetworkPaymentSources?.forEach((source) => {
      source.PurchasingWallets?.forEach((wallet) => {
        dynamicResults.push({
          id: wallet.walletAddress,
          title: 'Buying Wallet',
          description: (wallet.note ?? '') + ` Address: ${wallet.walletAddress}`,
          type: 'wallet',
          href: `/wallets?searched=${wallet.walletAddress}`,
          elementId: `wallet-${wallet.walletAddress}`,
        });
      });

      source.SellingWallets?.forEach((wallet) => {
        dynamicResults.push({
          id: wallet.walletAddress,
          title: 'Selling Wallet',
          description: (wallet.note ?? '') + ` Address: ${wallet.walletAddress}`,
          type: 'wallet',
          href: `/wallets?searched=${wallet.walletAddress}`,
          elementId: `wallet-${wallet.walletAddress}`,
        });
      });

      dynamicResults.push({
        id: source.id,
        title: 'Payment Source',
        description: `Contract: ${source.smartContractAddress}`,
        type: 'payment-source',
        href: `/payment-sources?searched=${source.id}`,
        elementId: `payment-source-${source.id}`,
      });
    });

    return [...searchableItems, ...dynamicResults];
  }, [currentNetworkPaymentSources]);

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
  };
}
