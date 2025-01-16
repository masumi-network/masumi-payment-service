import type { NextApiRequest, NextApiResponse } from 'next'
import 'dotenv/config'
import type { PaymentsQuery, PurchasesQuery } from '@/types/api'

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  if (req.method !== 'GET') {
    return res.status(405).json({ message: 'Method not allowed' })
  }

  try {
    const { 
      limit = 10,
      cursorIdentifier,
      network,
      sellingWalletVkey,
      paymentType,
      contractAddress
    }: PurchasesQuery = req.query

    const commonParams = {
      limit: limit.toString(),
      ...(cursorIdentifier && { cursorIdentifier }),
      ...(network && { network: network.toString() }),
      ...(paymentType && { paymentType: paymentType.toString() }),
      ...(contractAddress && { contractAddress: contractAddress.toString() })
    }

    const purchaseParams = {
      ...commonParams,
      ...(sellingWalletVkey && { sellingWalletVkey: sellingWalletVkey.toString() })
    }

    const [paymentsRes, purchasesRes] = await Promise.all([
      fetch(`${process.env.PAYMENT_API_BASE_URL}/api/v1/payment?${new URLSearchParams(commonParams).toString()}`, {
        method: 'GET',
        headers: {
          'accept': 'application/json',
          'token': process.env.PAYMENT_API_KEY as string
        }
      }),
      fetch(`${process.env.PAYMENT_API_BASE_URL}/api/v1/purchase?${new URLSearchParams(purchaseParams).toString()}`, {
        method: 'GET',
        headers: {
          'accept': 'application/json',
          'token': process.env.PAYMENT_API_KEY as string
        }
      })
    ])

    const [paymentsData, purchasesData] = await Promise.all([
      paymentsRes.json(),
      purchasesRes.json()
    ])

    const transactions = [
      ...(paymentsData.data?.payments || []).map((p: any) => ({ ...p, type: 'payment' })),
      ...(purchasesData.data?.purchases || []).map((p: any) => ({ ...p, type: 'purchase' }))
    ].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())

    return res.status(200).json({
      status: 'success',
      data: { transactions }
    })
  } catch (error: any) {
    console.error('Transactions fetch failed:', error)
    return res.status(500).json({ status: 'error', message: 'Failed to fetch transactions' })
  }
} 