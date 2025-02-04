import type { NextApiRequest, NextApiResponse } from 'next'

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  if (req.method !== 'POST') {
    return res.status(405).json({ message: 'Method not allowed' })
  }

  const token = req.headers.authorization?.replace('Bearer ', '')
  
  if (!token){
    return res.status(401).json({ 
      status: 'error',
      message: 'Unauthorized' 
    })
  }

  try {
    const payload = req.body

    if (!payload.blockfrostApiKey || !payload.AdminWallets?.length) {
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
        'token': token as string
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
