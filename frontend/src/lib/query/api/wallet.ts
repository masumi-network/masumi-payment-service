export interface Wallet {
  walletAddress: string;
  note?: string;
  type?: string;
}

export interface WalletResponse {
  status: 'success' | 'error';
  data?: {
    wallet: Wallet;
  };
  message?: string;
}

export interface WalletQuery {
  walletType?: string;
  id?: string;
  includeSecret?: boolean;
}

export async function getWallet(
  token: string,
  params: WalletQuery
): Promise<WalletResponse> {
  if (!token) {
    throw new Error('Authorization token is required')
  }

  try {
    const response = await fetch(
      `${process.env.NEXT_PUBLIC_PAYMENT_API_BASE_URL}/api/v1/wallet/?${new URLSearchParams(params as Record<string, string>).toString()}`,
      {
        headers: {
          'accept': 'application/json',
          'token': token
        }
      }
    );

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.message || 'Failed to fetch wallet data');
    }

    return {
      status: 'success',
      data
    };
  } catch (error) {
    console.error('Error fetching wallet data:', error);
    throw error;
  }
}

export async function createWallet(
  token: string,
  params: WalletQuery
): Promise<WalletResponse> {
  try {
    const response = await fetch(`${process.env.NEXT_PUBLIC_PAYMENT_API_BASE_URL}/api/v1/wallet/`, {
      method: 'POST',
      headers: {
        'token': token
      },
      body: JSON.stringify(params)
    });
    const data = await response.json();
    return data;
  } catch (error) {
    console.error('Error creating wallet:', error);
    throw error;
  }
}