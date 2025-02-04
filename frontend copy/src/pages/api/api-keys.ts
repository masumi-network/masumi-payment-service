import type { NextApiRequest, NextApiResponse } from 'next';

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  if (req.method !== 'GET') {
    return res.status(405).json({ message: 'Method not allowed' });
  }

  const token = req.headers.authorization?.replace('Bearer ', '');
  
  if (!token) {
    return res.status(401).json({ 
      status: 'error',
      message: 'Unauthorized' 
    });
  }

  try {
    const { limit = 10, cursorApiKey } = req.query;
    const queryParams = new URLSearchParams({
      limit: limit.toString(),
      ...(cursorApiKey && { cursorApiKey: cursorApiKey.toString() })
    }).toString();

    const response = await fetch(
      `${process.env.PAYMENT_API_BASE_URL}/api/v1/api-key/?${queryParams}`,
      {
        headers: {
          'accept': 'application/json',
          'token': token
        }
      }
    );

    if (!response.ok) {
      throw new Error('Failed to fetch API keys');
    }

    const data = await response.json();
    return res.status(200).json({
      status: 'success',
      keys: data.data.apiKeys
    });
  } catch (error) {
    console.error('Error fetching API keys:', error);
    return res.status(500).json({ 
      status: 'error', 
      message: 'Failed to fetch API keys' 
    });
  }
}