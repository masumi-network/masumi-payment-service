import type { NextApiRequest, NextApiResponse } from 'next'
import 'dotenv/config'

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  if (req.method !== 'DELETE') {
    return res.status(405).json({ message: 'Method not allowed' })
  }

  const { id } = req.query

  if (!id) {
    return res.status(400).json({ 
      status: 'error', 
      message: 'Contract ID is required' 
    })
  }

  try {
    const response = await fetch(
      `${process.env.PAYMENT_API_BASE_URL}/api/v1/payment-source/?id=${id}`, 
      {
        method: 'DELETE',
        headers: {
          'accept': 'application/json',
          'token': process.env.PAYMENT_API_KEY as string
        }
      }
    )

    const data = await response.json()

    if (!response.ok) {
        console.log(data)
      throw new Error(data.message || 'Failed to delete payment source')
    }

    return res.status(200).json(data)
  } catch (error: any) {
    console.error('Delete payment source failed:', error)
    return res.status(500).json({ 
      status: 'error', 
      message: error.message || 'Failed to delete payment source' 
    })
  }
} 