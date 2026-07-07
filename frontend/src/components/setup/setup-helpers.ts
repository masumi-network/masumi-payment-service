import { toast } from 'react-toastify';
import { copyToClipboard as copyTextToClipboard } from '@/lib/utils';

/** A generated setup wallet: its bech32 address and its recovery mnemonic. */
export type SetupWallet = { address: string; mnemonic: string };

export function formatNetworkDisplay(networkType: string): string {
  return networkType?.toUpperCase() === 'MAINNET' ? 'Mainnet' : 'Preprod';
}

export async function copyToClipboard(text: string) {
  // Awaited so a blocked clipboard (e.g. plain-HTTP host) surfaces as an error
  // instead of a false success — critical for seed phrases, which cannot be
  // recovered after the wizard.
  if (await copyTextToClipboard(text)) {
    toast.success('Copied to clipboard');
  } else {
    toast.error('Failed to copy to clipboard. Please copy manually.');
  }
}

export const STEP_LABELS = [
  'Welcome',
  'Seed phrases',
  'Payment source',
  'AI Agent (Optional)',
  'Complete',
];
