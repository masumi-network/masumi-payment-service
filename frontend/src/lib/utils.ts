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
 * Validates a Cardano wallet address based on network type
 *
 * @param address - The wallet address to validate
 * @param network - The network type ('Mainnet' or 'Preprod')
 * @returns An object with `isValid` boolean and optional `error` message
 *
 * Mainnet addresses:
 * - Start with 'addr1' (Shelley era)
 * - Typically 57-100+ characters in length
 *
 * Preprod/Testnet addresses:
 * - Start with 'addr_test' (Shelley era)
 * - Typically 64-100+ characters in length
 */
export function validateCardanoAddress(
  address: string,
  network: 'Mainnet' | 'Preprod',
): { isValid: boolean; error?: string } {
  if (!address || typeof address !== 'string') {
    return {
      isValid: false,
      error: 'Address is required and must be a string',
    };
  }

  const trimmedAddress = address.trim();

  if (trimmedAddress.length === 0) {
    return {
      isValid: false,
      error: 'Address cannot be empty',
    };
  }

  // Network-specific validation
  if (network === 'Mainnet') {
    // Mainnet addresses should start with 'addr1'
    if (!trimmedAddress.startsWith('addr1')) {
      return {
        isValid: false,
        error: 'Mainnet addresses must start with "addr1"',
      };
    }

    // Mainnet Shelley addresses are typically 57+ characters
    // Minimum length check to catch obviously invalid addresses
    if (trimmedAddress.length < 57) {
      return {
        isValid: false,
        error: 'Mainnet address appears to be too short',
      };
    }
  } else if (network === 'Preprod') {
    // Preprod/Testnet addresses should start with 'addr_test'
    if (!trimmedAddress.startsWith('addr_test')) {
      return {
        isValid: false,
        error: 'Preprod addresses must start with "addr_test"',
      };
    }

    // Preprod Shelley addresses are typically 64+ characters
    // Minimum length check to catch obviously invalid addresses
    if (trimmedAddress.length < 64) {
      return {
        isValid: false,
        error: 'Preprod address appears to be too short',
      };
    }
  } else {
    return {
      isValid: false,
      error: `Unsupported network: ${network}. Supported networks are 'Mainnet' and 'Preprod'`,
    };
  }

  // Basic base58 character check (Cardano addresses use base58 encoding)
  // Base58 characters: 123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz
  const base58Regex = /^[1-9A-HJ-NP-Za-km-z]+$/;
  if (!base58Regex.test(trimmedAddress)) {
    return {
      isValid: false,
      error:
        'Address contains invalid characters. Cardano addresses use base58 encoding.',
    };
  }

  // Maximum reasonable length check (prevent extremely long strings)
  if (trimmedAddress.length > 150) {
    return {
      isValid: false,
      error: 'Address appears to be too long',
    };
  }

  return { isValid: true };
}
