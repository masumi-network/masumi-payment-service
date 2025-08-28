/* eslint-disable @typescript-eslint/no-explicit-any */

import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';
import { toast } from 'react-toastify';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function shortenAddress(address: string, length: number = 4) {
  if (!address) return '';
  return address.slice(0, length) + '...' + address.slice(-length);
}

export async function copyToClipboard(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (err) {
    console.error('Failed to copy text: ', err);
    return false;
  }
}

export function parseError(error: any): string {
  if (error?.error) {
    return error.error;
  }
  if (error?.response?.data?.error) {
    return error.response.data.error;
  }
  if (error?.message) {
    return error.message;
  }
  return 'An error occurred';
}

export function parseFetchError(errorData: any, response: Response): string {
  return (
    errorData.message ||
    errorData.error ||
    `HTTP ${response.status}: ${response.statusText}`
  );
}

export async function handleApiCall<T>(
  apiCall: () => Promise<T>,
  options: {
    onSuccess?: (data: T) => void;
    onError?: (error: any) => void;
    onFinally?: () => void;
    errorMessage?: string;
  } = {},
): Promise<T | null> {
  try {
    const response = await apiCall();

    // Check for API errors (response.error pattern)
    if (
      response &&
      typeof response === 'object' &&
      'error' in response &&
      response.error
    ) {
      const error = response.error as { message: string };
      console.error('API Error:', error);

      if (options.onError) {
        options.onError(error);
      } else {
        toast.error(error.message || options.errorMessage || 'API call failed');
      }

      return null;
    }

    // Success case
    if (options.onSuccess) {
      options.onSuccess(response);
    }

    return response;
  } catch (error) {
    // Handle unexpected errors (network, etc.)
    console.error('Unexpected error:', error);

    if (options.onError) {
      options.onError(error);
    } else {
      toast.error(options.errorMessage || 'An unexpected error occurred');
    }

    return null;
  } finally {
    // Always execute cleanup
    if (options.onFinally) {
      options.onFinally();
    }
  }
}

export interface WalletWithLoadingState {
  id: string;
  walletVkey: string;
  walletAddress: string;
  collectionAddress: string | null;
  note: string | null;
  type: 'Purchasing' | 'Selling' | 'Collection';
  balance: string;
  usdmBalance: string;
  collectionBalance?: {
    ada: string;
    usdm: string;
  } | null;
  isLoadingBalance: boolean;
  isLoadingCollectionBalance: boolean;
}

export async function loadWalletsProgressively<
  T extends {
    id: string;
    walletAddress: string;
    collectionAddress?: string | null;
  },
>(
  wallets: T[],
  fetchBalanceFn: (address: string) => Promise<{ ada: string; usdm: string }>,
  onWalletUpdate: (
    walletId: string,
    updates: Partial<WalletWithLoadingState>,
  ) => void,
  walletTransformFn: (
    wallet: T,
    balance: { ada: string; usdm: string },
    collectionBalance?: { ada: string; usdm: string } | null,
  ) => WalletWithLoadingState,
): Promise<WalletWithLoadingState[]> {
  // First, display all wallets with loading states
  const initialWallets = wallets.map((wallet) =>
    walletTransformFn(wallet, { ada: '0', usdm: '0' }, null),
  );

  // Then fetch balances progressively
  const fetchPromises = wallets.map(async (wallet, index) => {
    const walletId = wallet.id || index.toString();

    // Fetch main wallet balance
    try {
      const balance = await fetchBalanceFn(wallet.walletAddress);
      onWalletUpdate(walletId, {
        balance: balance.ada,
        usdmBalance: balance.usdm,
        isLoadingBalance: false,
      });
    } catch (error) {
      console.error(`Failed to fetch balance for wallet ${walletId}:`, error);
      onWalletUpdate(walletId, {
        balance: '0',
        usdmBalance: '0',
        isLoadingBalance: false,
      });
    }

    // Fetch collection balance if exists
    if (wallet.collectionAddress) {
      try {
        const collectionBalance = await fetchBalanceFn(
          wallet.collectionAddress,
        );
        onWalletUpdate(walletId, {
          collectionBalance: {
            ada: collectionBalance.ada,
            usdm: collectionBalance.usdm,
          },
          isLoadingCollectionBalance: false,
        });
      } catch (error) {
        console.error(
          `Failed to fetch collection balance for wallet ${walletId}:`,
          error,
        );
        onWalletUpdate(walletId, {
          collectionBalance: { ada: '0', usdm: '0' },
          isLoadingCollectionBalance: false,
        });
      }
    }
  });

  // Wait for all balance fetching to complete
  await Promise.all(fetchPromises);

  // Return the final state (this will be updated by the onWalletUpdate callback)
  return initialWallets;
}
