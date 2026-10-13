import { deserializeAddress } from '@meshsdk/core';

/** CIP-30 `getNetworkId`: 0 for every testnet, 1 for mainnet. */
export const CIP30_NETWORK_ID = { Preprod: 0, Mainnet: 1 } as const;

/** The payment key hash of a bech32 address, or null for script or unreadable addresses. */
export function paymentKeyHashOf(address: string): string | null {
  try {
    const keyHash = deserializeAddress(address).pubKeyHash;
    return keyHash === '' ? null : keyHash.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * True when one of the browser wallet's addresses carries the owner's payment
 * key. The server checks the owner witness itself; this only stops a sign
 * prompt that the server would refuse.
 */
export function walletHoldsOwnerKey(walletAddresses: string[], ownerAddress: string): boolean {
  const ownerKeyHash = paymentKeyHashOf(ownerAddress);
  if (ownerKeyHash == null) return false;
  return walletAddresses.some((address) => paymentKeyHashOf(address) === ownerKeyHash);
}
