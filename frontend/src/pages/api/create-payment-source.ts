import type { NextApiRequest, NextApiResponse } from 'next'
import 'dotenv/config'

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  if (req.method !== 'POST') {
    return res.status(405).json({ message: 'Method not allowed' })
  }

  try {
    const payload = req.body

    if (!payload.addressToCheck || !payload.blockfrostApiKey) {
      return res.status(400).json({
        status: 'error',
        message: 'Missing required fields'
      })
    }

    const response = await fetch(`${process.env.PAYMENT_API_BASE_URL}/api/v1/payment-source`, {
      method: 'POST',
      headers: {
        'accept': 'application/json',
        'Content-Type': 'application/json',
        'token': process.env.PAYMENT_API_KEY as string
      },
      body: JSON.stringify({
        network: payload.network,
        paymentType: payload.paymentType,
        addressToCheck: payload.addressToCheck,
        blockfrostApiKey: payload.blockfrostApiKey,
        scriptJSON: payload.scriptJSON || '{}',
        registryJSON: payload.registryJSON || '{}',
        AdminWallets: payload.AdminWallets,
        FeeReceiverNetworkWallet: payload.FeeReceiverNetworkWallet,
        FeePermille: payload.FeePermille,
        CollectionWallet: payload.CollectionWallet,
        PurchasingWallets: payload.PurchasingWallets,
        SellingWallet: payload.SellingWallet
      })
    })

    const data = await response.json()

    if (!response.ok) {
      return res.status(response.status).json({
        status: 'error',
        message: data.message || 'Failed to create payment source'
      })
    }

    return res.status(201).json({
      status: 'success',
      data
    })
  } catch (error: any) {
    console.error('Create payment source failed:', error)
    return res.status(500).json({
      status: 'error',
      message: error.message || 'Failed to create payment source'
    })
  }
}
