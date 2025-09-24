/* eslint-disable @typescript-eslint/no-explicit-any */

import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

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
