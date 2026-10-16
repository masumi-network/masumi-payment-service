import type { X402Wallet } from '@/lib/api/generated';

export type X402WalletType = X402Wallet['type'];
export type X402WalletKeySource = 'generate' | 'import';

const PRIVATE_KEY_REGEX = /^0x[a-fA-F0-9]{64}$/;

export const IMPORTED_KEY_FORMAT_ERROR =
  'Enter the private key as 0x followed by 64 hex characters.';

/** Validates an operator-pasted EVM private key. Surrounding whitespace is ignored. */
export function parseImportedPrivateKey(
  input: string,
): { ok: true; privateKey: string } | { ok: false; error: string } {
  const privateKey = input.trim();
  return PRIVATE_KEY_REGEX.test(privateKey)
    ? { ok: true, privateKey }
    : { ok: false, error: IMPORTED_KEY_FORMAT_ERROR };
}

/** Plain-text contents of the one-time private-key backup file. */
export function buildPrivateKeyBackupText({
  type,
  address,
  privateKey,
}: {
  type: X402WalletType;
  address: string;
  privateKey: string;
}): string {
  return [
    'Masumi x402 managed wallet: PRIVATE KEY BACKUP',
    `Direction: ${type}`,
    `Address:   ${address}`,
    `Private key: ${privateKey}`,
    '',
    'Keep this file secret. Anyone with this key controls the wallet’s funds.',
  ].join('\n');
}

export function privateKeyBackupFileName(address: string): string {
  return `x402-wallet-${address.slice(0, 10)}.txt`;
}
