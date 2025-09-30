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

export function getExplorerUrl(
  address: string,
  network: string,
  type: 'address' | 'transaction' = 'address',
): string {
  const baseUrl =
    network === 'Mainnet'
      ? 'https://cardanoscan.io'
      : 'https://preprod.cardanoscan.io';
  return `${baseUrl}/${type}/${address}`;
}

/**
 * Formats count for display
 * Shows exact count up to maxValue, shows "maxValue+" for counts > maxValue
 *
 * @param count - The count to format
 * @param maxValue - The maximum value to display before showing "maxValue+" (default: 999)
 * @returns Formatted count string
 */
export function formatCount(count: number, maxValue: number = 999): string {
  if (count <= 0) {
    return '';
  }

  if (count > maxValue) {
    return `${maxValue}+`;
  }

  return count.toString();
}

/**
 * Date range utilities for transaction filtering
 */
export const dateRangeUtils = {
  /**
   * Get date range for preset options
   */
  getPresetRange(preset: '24h' | '7d' | '30d' | '90d'): {
    start: Date;
    end: Date;
  } {
    const now = new Date();
    const end = now;

    let start: Date;
    switch (preset) {
      case '24h':
        start = new Date(now.getTime() - 24 * 60 * 60 * 1000);
        break;
      case '7d':
        start = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
        break;
      case '30d':
        start = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
        break;
      case '90d':
        start = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);
        break;
      default:
        start = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    }

    return { start, end };
  },

  /**
   * Format date range for display
   */
  formatDateRange(start: Date, end: Date): string {
    const formatDate = (date: Date) => {
      return date.toLocaleDateString('en-US', {
        month: 'short',
        day: 'numeric',
        year:
          date.getFullYear() !== new Date().getFullYear()
            ? 'numeric'
            : undefined,
      });
    };

    return `${formatDate(start)} - ${formatDate(end)}`;
  },

  /**
   * Check if a date is within range
   */
  isDateInRange(date: Date, start: Date, end: Date): boolean {
    return date >= start && date <= end;
  },

  /**
   * Get ISO string for API calls
   */
  toISOString(date: Date): string {
    return date.toISOString();
  },
};
