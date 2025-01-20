import 'dotenv/config'

export interface PaymentSource {
  id: string;
  network?: string;
  paymentType?: string;
  blockfrostApiKey: string;
  AdminWallets: string[];
  FeeReceiverNetworkWallet?: string;
  FeePermille?: number;
  CollectionWallet?: string;
  PurchasingWallets?: string[];
  SellingWallets?: string[];
  createdAt: string;
  updatedAt: string;
}

export interface PaymentSourceResponse {
  status: 'success' | 'error';
  data?: {
    paymentSources: PaymentSource[];
  };
  message?: string;
}

export async function getPaymentSources(token: string, take: number = 10): Promise<PaymentSourceResponse> {
  if (!token) {
    throw new Error('Authorization token is required')
  }

  try {
    const response = await fetch(`${process.env.NEXT_PUBLIC_PAYMENT_API_BASE_URL}/api/v1/payment-source/?take=${take}`, {
      method: 'GET',
      headers: {
        'accept': 'application/json',
        'token': token
      }
    })

    const data = await response.json()

    if (!response.ok) {
      throw new Error(data.message || 'Failed to fetch payment sources')
    }

    return data
  } catch (error) {
    console.error('Payment source check failed:', error)
    throw error
  }
}
