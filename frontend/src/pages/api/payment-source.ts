import type { NextApiRequest, NextApiResponse } from 'next'
import 'dotenv/config'

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  if (req.method !== 'GET') {
    return res.status(405).end()
  }

  const token = req.headers.authorization?.replace('Bearer ', '')
  
  if (!token){
    return res.status(401).json({ 
      status: 'error',
      message: 'Unauthorized' 
    })
  }

  try {
    const take = req.query.take || 10
    const response = await fetch(`${process.env.PAYMENT_API_BASE_URL}/api/v1/payment-source/?take=${take}`, {
      method: 'GET',
      headers: {
        'accept': 'application/json',
        'token': token as string
      }
    })

    const data = await response.json()
    return res.status(response.status).json(data)
  } catch (error) {
    console.error('Payment source check failed:', error)
    return res.status(500).json({ status: 'error', message: 'Failed to check payment source' })
  }
}
