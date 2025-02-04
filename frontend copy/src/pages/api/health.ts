import type { NextApiRequest, NextApiResponse } from 'next'
import 'dotenv/config'

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  if (req.method !== 'GET') {
    return res.status(405).end()
  }

  try {
    const response = await fetch(`${process.env.PAYMENT_API_BASE_URL}/api/v1/health/`, {
      method: 'GET',
      headers: {
        'accept': 'application/json'
      }
    })

    const data = await response.json()
    return res.status(response.status).json(data)
  } catch (error) {
    console.error('Health check failed:', error)
    return res.status(500).json({ status: 'error', message: 'Failed to check health status' })
  }
}
