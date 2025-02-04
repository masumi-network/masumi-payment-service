import type { NextApiRequest, NextApiResponse } from 'next';

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  if (req.method !== 'PATCH') {
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
    const response = await fetch(
      `${process.env.PAYMENT_API_BASE_URL}/api/v1/api-key`,
      {
        method: 'PATCH',
        headers: {
          'accept': 'application/json',
          'Content-Type': 'application/json',
          'token': token
        },
        body: JSON.stringify(req.body)
      }
    );

    const data = await response.json();
    
    if (!response.ok) {
      throw new Error(data.message || 'Failed to update API key');
    }

    return res.status(200).json(data);
  } catch (error: any) {
    console.error('Error updating API key:', error);
    return res.status(500).json({ 
      status: 'error', 
      message: error.message || 'Failed to update API key' 
    });
  }
} 