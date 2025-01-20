

export type BalanceResponse = {
  ada: number;
  usdm: number;
} | {
  error: string;
}

export interface Asset {
  unit: string;
  quantity: string;
}

export interface AddressBalance {
  amount: Array<{ quantity: string; unit: string; }>;
}

export async function getWalletBalance(address: string, apiKey: string): Promise<BalanceResponse> {
  try {
    const balanceResponse = await fetch(
      `https://cardano-preprod.blockfrost.io/api/v0/addresses/${address}`,
      {
        headers: {
          'project_id': apiKey,
        },
      }
    );

    if (!balanceResponse.ok) {
      throw new Error('Failed to fetch ADA balance');
    }

    const balanceData: AddressBalance = await balanceResponse.json();

    // Convert lovelace to ADA (1 ADA = 1,000,000 lovelace)
    const adaBalance = parseInt(balanceData.amount[0].quantity) / 1000000;

    // Fetch asset balances to find USDM
    const assetsResponse = await fetch(
      `https://cardano-preprod.blockfrost.io/api/v0/addresses/${address}/assets`,
      {
        headers: {
          'project_id': apiKey,
        },
      }
    );

    if (!assetsResponse.ok) {
      throw new Error('Failed to fetch assets');
    }

    const assetsData: Asset[] = await assetsResponse.json();

    const usdmAsset = assetsData.find((asset) =>
      asset.unit === 'YOUR_USDM_ASSET_ID'
    );

    const usdmBalance = usdmAsset ? parseInt(usdmAsset.quantity) : 0;

    return {
      ada: adaBalance,
      usdm: usdmBalance
    };

  } catch (error) {
    console.error('Error fetching wallet balance:', error);
    return { error: 'Failed to fetch wallet balance' };
  }
}
