/* eslint-disable @typescript-eslint/no-explicit-any */
export interface CreatePaymentSourcePayload {
  network?: string;
  paymentType?: string;
  blockfrostApiKey: string;
  AdminWallets: any[];
  FeeReceiverNetworkWallet?: any;
  FeePermille?: number;
  CollectionWallet?: any;
  PurchasingWallets?: any[];
  SellingWallets?: any[];
}

export interface PaymentSourceData {
  id: string;
  [key: string]: unknown;
}

export interface CreatePaymentSourceResponse {
  status: 'success' | 'error';
  data?: PaymentSourceData;
  message?: string;
}

export async function createPaymentSource(
  payload: CreatePaymentSourcePayload,
  token: string
): Promise<CreatePaymentSourceResponse> {
  if (!payload.blockfrostApiKey || !payload.AdminWallets?.length) {
    throw new Error('Missing required fields');
  }

  try {
    const response = await fetch(`${process.env.NEXT_PUBLIC_PAYMENT_API_BASE_URL}/api/v1/payment-source`, {
      method: 'POST',
      headers: {
        'accept': 'application/json',
        'Content-Type': 'application/json',
        'token': token
      },
      body: JSON.stringify({
        network: payload.network,
        paymentType: payload.paymentType,
        blockfrostApiKey: payload.blockfrostApiKey,
        AdminWallets: payload.AdminWallets,
        FeeReceiverNetworkWallet: payload.FeeReceiverNetworkWallet,
        FeePermille: payload.FeePermille,
        CollectionWallet: payload.CollectionWallet,
        PurchasingWallets: payload.PurchasingWallets,
        SellingWallets: payload.SellingWallets
      })
    });

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.message || 'Failed to create payment source');
    }

    return {
      status: 'success',
      data
    };
  } catch (error) {
    console.error('Create payment source failed:', error);
    throw error;
  }
}
