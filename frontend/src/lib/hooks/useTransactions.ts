/* eslint-disable @typescript-eslint/no-explicit-any */
/* eslint-disable react-hooks/exhaustive-deps */

import { useState, useEffect, useCallback } from 'react';
import { useAppContext } from '@/lib/contexts/AppContext';
import { getPayment, getPurchase } from '@/lib/api/generated';

interface Transaction {
  id: string;
  type: 'payment' | 'purchase';
  createdAt: string;
  updatedAt: string;
  onChainState: string;
  Amounts: Array<{
    amount: string;
    unit: string;
  }>;
  PaymentSource: {
    network: 'Preprod' | 'Mainnet';
    paymentType: string;
  };
  CurrentTransaction?: {
    txHash: string | null;
  } | null;
  NextAction?: {
    errorType?: string;
    errorNote?: string | null;
  };
  SmartContractWallet?: {
    walletAddress: string;
  } | null;
}

export function useTransactions() {
  const { apiClient } = useAppContext();
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [hasMore, setHasMore] = useState(true);
  const [cursorId, setCursorId] = useState<string | null>(null);
  const [newTransactionsCount, setNewTransactionsCount] = useState(0);
  const [lastCheckedTimestamp, setLastCheckedTimestamp] = useState<string | null>(null);

  const fetchTransactions = useCallback(async (cursor?: string, checkForNew = false) => {
    setIsLoading(true);
    try {
      const combined: Transaction[] = [];

      const purchases = await getPurchase({
        client: apiClient,
        query: {
          network: 'Preprod',
          cursorId: cursor,
          includeHistory: 'true',
          limit: 10
        }
      });

      if (purchases.data?.data?.Purchases) {
        purchases.data.data.Purchases.forEach((purchase: any) => {
          combined.push({
            ...purchase,
            type: 'purchase'
          });
        });
      }

      const payments = await getPayment({
        client: apiClient,
        query: {
          network: 'Preprod',
          cursorId: cursor,
          includeHistory: 'true',
          limit: 10
        }
      });

      if (payments.data?.data?.Payments) {
        payments.data.data.Payments.forEach((payment: any) => {
          combined.push({
            ...payment,
            type: 'payment'
          });
        });
      }

      const newTransactions = combined.sort((a, b) => 
        new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
      );

      if (checkForNew && lastCheckedTimestamp) {
        const newCount = newTransactions.filter(
          tx => new Date(tx.createdAt) > new Date(lastCheckedTimestamp)
        ).length;
        setNewTransactionsCount(prev => prev + newCount);
      }

      if (!checkForNew) {
        setTransactions(prev => cursor ? [...prev, ...newTransactions] : newTransactions);
        setHasMore(
          (purchases.data?.data?.Purchases?.length === 10) || 
          (payments.data?.data?.Payments?.length === 10)
        );
        setCursorId(newTransactions[newTransactions.length - 1]?.id ?? null);
      }
    } catch (error) {
      console.error('Failed to fetch transactions:', error);
    } finally {
      setIsLoading(false);
    }
  }, [apiClient, lastCheckedTimestamp]);

  useEffect(() => {
    fetchTransactions();
  }, [apiClient]);

  useEffect(() => {
    if (!lastCheckedTimestamp) {
      setLastCheckedTimestamp(new Date().toISOString());
    }
  }, [lastCheckedTimestamp]);

  useEffect(() => {
    const interval = setInterval(() => {
      fetchTransactions(undefined, true);
    }, 60000);

    return () => clearInterval(interval);
  }, [fetchTransactions]);

  const markAllAsRead = useCallback(() => {
    setNewTransactionsCount(0);
    setLastCheckedTimestamp(new Date().toISOString());
  }, []);

  const loadMore = useCallback(() => {
    if (cursorId && !isLoading) {
      fetchTransactions(cursorId);
    }
  }, [cursorId, isLoading, fetchTransactions]);

  return {
    transactions,
    isLoading,
    hasMore,
    loadMore,
    newTransactionsCount,
    markAllAsRead
  };
} 