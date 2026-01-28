import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';
import { toast } from 'react-toastify';
import { deserializeAddress } from '@meshsdk/core';
import { TESTUSDM_CONFIG, getUsdmConfig } from '@/lib/constants/defaultWallets';

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
  return errorData.message || errorData.error || `HTTP ${response.status}: ${response.statusText}`;
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
    if (response && typeof response === 'object' && 'error' in response && response.error) {
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
    network === 'Mainnet' ? 'https://cardanoscan.io' : 'https://preprod.cardanoscan.io';
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
        year: date.getFullYear() !== new Date().getFullYear() ? 'numeric' : undefined,
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

/**
 * Validates a Cardano wallet address based on network type using MeshJS
 *
 * @param address - The wallet address to validate
 * @param network - The network type ('Mainnet' or 'Preprod')
 * @returns An object with `isValid` boolean and optional `error` message
 *
 * Uses MeshJS's deserializeAddress for proper Bech32 checksum validation
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

  // Normalize to lowercase (Bech32 addresses are case-insensitive but conventionally lowercase)
  const normalizedAddress = trimmedAddress.toLowerCase();

  // Network-specific prefix validation
  let expectedPrefix: string;
  if (network === 'Mainnet') {
    expectedPrefix = 'addr1';
  } else if (network === 'Preprod') {
    expectedPrefix = 'addr_test1';
  } else {
    return {
      isValid: false,
      error: `Unsupported network: ${network}. Supported networks are 'Mainnet' and 'Preprod'`,
    };
  }

  if (!normalizedAddress.startsWith(expectedPrefix)) {
    return {
      isValid: false,
      error: `${network} address must start with "${expectedPrefix}"`,
    };
  }

  // Use MeshJS to validate Bech32 encoding and checksum
  try {
    deserializeAddress(normalizedAddress);
    return { isValid: true };
  } catch {
    return {
      isValid: false,
      error: 'Invalid Cardano address',
    };
  }
}

export function hexToAscii(hex: string) {
  try {
    const bytes = hex.match(/.{1,2}/g)?.map((byte) => parseInt(byte, 16)) || [];
    return bytes.map((byte) => String.fromCharCode(byte)).join('');
  } catch {
    return hex;
  }
}

/**
 * Format fund unit for display
 * Converts unit identifiers (lovelace, USDM, tUSDM, policy IDs) to user-friendly display names
 *
 * @param unit - The unit identifier (e.g., 'lovelace', 'USDM', policy ID, etc.)
 * @param network - The network type ('Mainnet' or 'Preprod')
 * @returns Formatted unit string for display (e.g., 'ADA', 'USDM', 'tUSDM')
 */
export function formatFundUnit(unit: string | undefined, network: string | undefined): string {
  if (!network) {
    // If no network, fallback to basic unit formatting
    if (unit === 'lovelace' || !unit) {
      return 'ADA';
    }
    return unit;
  }

  if (!unit) {
    return 'ADA';
  }

  const usdmConfig = getUsdmConfig(network);
  const isUsdm =
    unit === usdmConfig.fullAssetId ||
    unit === usdmConfig.policyId ||
    unit === 'USDM' ||
    unit === 'tUSDM';

  if (isUsdm) {
    return network.toLowerCase() === 'preprod' ? 'tUSDM' : 'USDM';
  }

  const isTestUsdm = unit === TESTUSDM_CONFIG.unit;
  if (isTestUsdm) {
    return 'tUSDM';
  }

  if (unit === 'lovelace') {
    return 'ADA';
  }

  return unit ?? '—';
}

/**
 * Normalizes a pathname by removing the basePath
 * This ensures path comparisons work correctly with Next.js basePath configuration
 *
 * @param pathname - The pathname to normalize (e.g., '/admin/setup' or '/setup')
 * @param basePath - The basePath configured in next.config.ts (default: '/admin')
 * @returns The normalized pathname without basePath (e.g., '/setup')
 */
export function normalizePathname(pathname: string, basePath: string = '/admin'): string {
  if (!pathname) return '/';

  // Remove basePath if present
  if (pathname.startsWith(basePath)) {
    const normalized = pathname.slice(basePath.length);
    return normalized || '/';
  }

  return pathname;
}
