import { UTxO } from '@meshsdk/core';
import { SERVICE_CONSTANTS } from '@/utils/config';

/**
 * Sorts UTXOs by lovelace amount in descending order (O(n log n))
 */
export function sortUtxosByLovelaceDesc(utxos: UTxO[]): UTxO[] {
  // Extract lovelace amounts once for better performance
  const utxosWithLovelace = utxos.map((utxo) => ({
    utxo,
    lovelace: parseInt(
      utxo.output.amount.find(
        (asset) => asset.unit === 'lovelace' || asset.unit === '',
      )?.quantity ?? '0',
    ),
  }));

  // Sort by lovelace amount (descending)
  return utxosWithLovelace
    .sort((a, b) => b.lovelace - a.lovelace)
    .map((item) => item.utxo);
}

/**
 * Limits UTXOs to maximum count for transaction size optimization
 */
export function limitUtxos(utxos: UTxO[], maxCount?: number): UTxO[] {
  const limit = maxCount ?? SERVICE_CONSTANTS.TRANSACTION.maxUtxos;
  return utxos.slice(0, Math.min(limit, utxos.length));
}

/**
 * Combined function: sort and limit UTXOs in one operation
 */
export function sortAndLimitUtxos(utxos: UTxO[], maxCount?: number): UTxO[] {
  const sortedUtxos = sortUtxosByLovelaceDesc(utxos);
  return limitUtxos(sortedUtxos, maxCount);
}

/**
 * Gets the UTXO with highest lovelace amount (for transaction fees)
 * Returns the first UTXO after sorting by lovelace descending
 */
export function getHighestLovelaceUtxo(utxos: UTxO[]): UTxO | undefined {
  return sortUtxosByLovelaceDesc(utxos)[0];
}
