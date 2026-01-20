import { Network, HotWalletType } from '@/generated/prisma/enums';
import { ApiClient } from './apiClient';
import '../setup/globals';

/**
 * Helper functions for querying PaymentSource data in E2E tests
 * 
 * Uses the API client to query payment sources instead of direct database access.
 */

/**
 * Get the active smart contract address for a given network
 */
export async function getActiveSmartContractAddress(
  network: Network,
  apiClient?: ApiClient,
): Promise<string> {
  const client = apiClient || global.testApiClient;

  if (!client) {
    throw new Error(
      'ApiClient not provided and global.testApiClient is not available',
    );
  }

  const response = await client.queryPaymentSources({ take: 100 });

  // Filter by network and find the most recent (first in descending order)
  const paymentSource = response.ExtendedPaymentSources.find(
    (ps) => ps.network === network,
  );

  if (!paymentSource) {
    throw new Error(
      `No active PaymentSource found for network ${network}. Please run database seeding first.`,
    );
  }

  return paymentSource.smartContractAddress;
}

/**
 * Get an active wallet VKey for testing by wallet type and network
 */
export async function getActiveWalletVKey(
  network: Network,
  walletType: HotWalletType = HotWalletType.Selling,
  apiClient?: ApiClient,
): Promise<string> {
  const client = apiClient || global.testApiClient;

  if (!client) {
    throw new Error(
      'ApiClient not provided and global.testApiClient is not available',
    );
  }

  const response = await client.queryPaymentSources({ take: 100 });

  // Find the payment source for the given network
  const paymentSource = response.ExtendedPaymentSources.find(
    (ps) => ps.network === network,
  );

  if (!paymentSource) {
    throw new Error(
      `No active PaymentSource found for network ${network}. Please run database seeding first.`,
    );
  }

  // Get wallets based on type
  const wallets =
    walletType === HotWalletType.Selling
      ? paymentSource.SellingWallets
      : paymentSource.PurchasingWallets;

  if (wallets.length === 0) {
    throw new Error(
      `No active ${walletType} wallet found for network ${network}. Please run database seeding first.`,
    );
  }

  // Get the first wallet (payment sources are returned in descending order by createdAt)
  const wallet = wallets[0];

  console.log(
    `✅ Found active ${walletType} wallet for ${network}: ${wallet.walletVkey}`,
  );

  return wallet.walletVkey;
}

/**
 * Get test wallet configuration dynamically from API
 */
export async function getTestWalletFromDatabase(
  network: Network,
  role: 'seller' | 'buyer',
  apiClient?: ApiClient,
): Promise<{
  name: string;
  vkey: string;
  description: string;
}> {
  const walletType =
    role === 'seller' ? HotWalletType.Selling : HotWalletType.Purchasing;

  try {
    const vkey = await getActiveWalletVKey(network, walletType, apiClient);

    return {
      name: `Dynamic ${role} wallet (${network})`,
      vkey: vkey,
      description: `Dynamically retrieved ${role} wallet for ${network} e2e tests`,
    };
  } catch (error) {
    throw new Error(`Failed to get ${role} wallet for ${network}: ${error}`);
  }
}

export default {
  getActiveSmartContractAddress,
  getActiveWalletVKey,
  getTestWalletFromDatabase,
};
