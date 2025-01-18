import type { NextApiRequest, NextApiResponse } from 'next'
import 'dotenv/config'

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  if (req.method !== 'PATCH') {
    return res.status(405).json({ message: 'Method not allowed' })
  }

  try {
    const payload = req.body

    if (!payload.id) {
      return res.status(400).json({
        status: 'error',
        message: 'Payment source ID is required'
      })
    }

    const details = JSON.stringify({
      id: payload.id,
      latestIdentifier: payload.latestIdentifier || undefined,
      page: payload.page || undefined,
      blockfrostApiKey: payload.blockfrostApiKey || undefined,
      CollectionWallet: payload.CollectionWallet || undefined,
      AddPurchasingWallets: payload.AddPurchasingWallets || undefined,
      AddSellingWallets: payload.AddSellingWallets || undefined,
      RemovePurchasingWallets: payload.RemovePurchasingWallets || undefined,
      RemoveSellingWallets: payload.RemoveSellingWallets || undefined
    })

    console.log(details)

    const response = await fetch(`${process.env.PAYMENT_API_BASE_URL}/api/v1/payment-source`, {
      method: 'PATCH',
      headers: {
        'accept': 'application/json',
        'Content-Type': 'application/json',
        'token': process.env.PAYMENT_API_KEY as string
      },
      body: details
    })

    const data = await response.json()

    if (!response.ok) {
      return res.status(response.status).json({
        status: 'error',
        message: data.message || 'Failed to update payment source'
      })
    }

    return res.status(200).json({
      status: 'success',
      data
    })
  } catch (error: any) {
    console.error('Update payment source failed:', error)
    return res.status(500).json({
      status: 'error',
      message: error.message || 'Failed to update payment source'
    })
  }
}
