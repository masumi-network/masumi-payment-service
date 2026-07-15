import { getUtxos, Utxo } from '@/lib/api/generated';
import { Client } from '@/lib/api/generated/client';
import { getActiveStablecoinConfig } from '@/lib/constants/defaultWallets';

const UTXO_PAGE_SIZE = 100;
// Backend caps `page` at 100, so 100 * 100 = 10k UTxOs max per address.
const UTXO_MAX_PAGES = 100;

export type WalletBalanceResult = {
  ada: string;
  usdcx: string;
  /**
   * True when the balance could not be fetched (API/network error). `ada` and
   * `usdcx` are '0' in that case, but consumers must render "unknown", not a
   * zero balance — the two are not the same thing.
   */
  unavailable?: boolean;
};

/**
 * Fetch ALL UTxOs for an address, paging through GET /utxos.
 *
 * The backend defaults `count` to 10 and does not aggregate pages, so a single
 * un-paged call silently understates the balance of any wallet holding more
 * than 10 UTxOs. Every balance computation must go through this helper (or
 * `fetchWalletBalance`) instead of calling getUtxos directly.
 *
 * Returns [] for a 404 (address never used). Throws on other API errors so
 * callers can distinguish "no funds" from "unknown".
 */
export async function fetchAllUtxos(
  apiClient: Client,
  network: 'Preprod' | 'Mainnet',
  address: string,
): Promise<Utxo[]> {
  const utxos: Utxo[] = [];

  for (let page = 1; page <= UTXO_MAX_PAGES; page++) {
    const response = await getUtxos({
      client: apiClient,
      query: {
        address,
        network,
        count: UTXO_PAGE_SIZE,
        page,
      },
    });

    if (response.status === 404) {
      return utxos;
    }
    if (response.error) {
      throw new Error(
        typeof response.error === 'object'
          ? JSON.stringify(response.error)
          : String(response.error),
      );
    }

    const pageUtxos = response.data?.data?.Utxos ?? [];
    utxos.push(...pageUtxos);
    if (pageUtxos.length < UTXO_PAGE_SIZE) {
      break;
    }
  }

  return utxos;
}

/**
 * Sum an address's ADA and active-stablecoin balances across all its UTxOs.
 *
 * Tracks only the active stablecoin for this network (USDCx on Mainnet, tUSDM
 * on Preprod). Legacy USDM tokens in Mainnet wallets are intentionally excluded
 * from this summary; they are still visible individually in WalletDetailsDialog.
 *
 * On fetch failure this returns `{ ada: '0', usdcx: '0', unavailable: true }`
 * instead of throwing, so one flaky address doesn't fail a whole wallet-list
 * query — but consumers must check `unavailable` before presenting the zeros.
 */
export async function fetchWalletBalance(
  apiClient: Client,
  network: 'Preprod' | 'Mainnet',
  address: string,
): Promise<WalletBalanceResult> {
  let utxos: Utxo[];
  try {
    utxos = await fetchAllUtxos(apiClient, network, address);
  } catch (error) {
    console.error('Error fetching wallet balance:', error);
    return { ada: '0', usdcx: '0', unavailable: true };
  }

  let adaBalance = BigInt(0);
  let usdcxBalance = BigInt(0);
  const stablecoinConfig = getActiveStablecoinConfig(network);

  for (const utxo of utxos) {
    for (const amount of utxo.Amounts) {
      if (amount.unit === 'lovelace' || amount.unit === '') {
        adaBalance += BigInt(amount.quantity ?? 0);
      } else if (amount.unit === stablecoinConfig.fullAssetId) {
        usdcxBalance += BigInt(amount.quantity ?? 0);
      }
    }
  }

  return {
    ada: adaBalance.toString(),
    usdcx: usdcxBalance.toString(),
  };
}
