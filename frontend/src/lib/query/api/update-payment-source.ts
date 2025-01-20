/* eslint-disable @typescript-eslint/no-explicit-any */
import { PaymentSource } from './payment-source'

export interface UpdatePaymentSourcePayload {
  id: string
  latestIdentifier?: string
  page?: string
  blockfrostApiKey?: string
  CollectionWallet?: any
  AddPurchasingWallets?: any[]
  AddSellingWallets?: any[]
  RemovePurchasingWallets?: any[]
  RemoveSellingWallets?: any[]
}

export interface UpdatePaymentSourceResponse {
  status: 'success' | 'error'
  data?: PaymentSource
  message?: string
}

export async function updatePaymentSource(
  payload: UpdatePaymentSourcePayload,
  token: string
): Promise<UpdatePaymentSourceResponse> {
  if (!payload.id) {
    throw new Error('Payment source ID is required')
  }

  if (!token) {
    throw new Error('Authorization token is required')
  }

  try {
    const response = await fetch(`${process.env.NEXT_PUBLIC_PAYMENT_API_BASE_URL}/api/v1/payment-source`, {
      method: 'PATCH',
      headers: {
        'accept': 'application/json',
        'Content-Type': 'application/json',
        'token': token
      },
      body: JSON.stringify({
        id: payload.id,
        latestIdentifier: payload.latestIdentifier,
        page: payload.page,
        blockfrostApiKey: payload.blockfrostApiKey,
        CollectionWallet: payload.CollectionWallet,
        AddPurchasingWallets: payload.AddPurchasingWallets,
        AddSellingWallets: payload.AddSellingWallets,
        RemovePurchasingWallets: payload.RemovePurchasingWallets,
        RemoveSellingWallets: payload.RemoveSellingWallets
      })
    })

    const data = await response.json()

    if (!response.ok) {
      throw new Error(data.message || 'Failed to update payment source')
    }

    return {
      status: 'success',
      data
    }
  } catch (error) {
    console.error('Update payment source failed:', error)
    throw error
  }
}
