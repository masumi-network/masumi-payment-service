import type { NextApiRequest, NextApiResponse } from 'next';

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  if (req.method !== 'GET') {
    return res.status(405).json({ message: 'Method not allowed' });
  }

  const token = req.headers.authorization?.replace('Bearer ', '')
  
  if (!token){
    return res.status(401).json({ 
      status: 'error',
      message: 'Unauthorized' 
    })
  }

  const { walletType, id, includeSecret } = req.query;

  try {
    const response = await fetch(
      `${process.env.PAYMENT_API_BASE_URL}/api/v1/wallet/?walletType=${walletType}&id=${id}&includeSecret=${includeSecret}`,
      {
        headers: {
          'accept': 'application/json',
          'token': token as string
        }
      }
    );

    if (!response.ok) {
      throw new Error('Failed to fetch wallet data');
    }

    const data = await response.json();
    return res.status(200).json(data);
  } catch (error) {
    console.error('Error fetching wallet data:', error);
    return res.status(500).json({ message: 'Failed to fetch wallet data' });
  }
} 