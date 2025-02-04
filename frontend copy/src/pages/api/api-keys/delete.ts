import type { NextApiRequest, NextApiResponse } from 'next';

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  if (req.method !== 'DELETE') {
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
    // The request body should contain either id or apiKey
    const { id, apiKey } = req.body;
    if (!id && !apiKey) {
      return res.status(400).json({
        status: 'error',
        message: 'Either id or apiKey must be provided'
      });
    }

    const response = await fetch(
      `${process.env.PAYMENT_API_BASE_URL}/api/v1/api-key/`,
      {
        method: 'DELETE',
        headers: {
          'accept': 'application/json',
          'Content-Type': 'application/json',
          'token': token
        },
        body: JSON.stringify({ apiKey }) // Send the properly formatted request body
      }
    );

    const data = await response.json();
    
    if (!response.ok) {
      throw new Error(data.message || 'Failed to delete API key');
    }

    return res.status(200).json(data);
  } catch (error: any) {
    console.error('Error deleting API key:', error);
    return res.status(500).json({ 
      status: 'error', 
      message: error.message || 'Failed to delete API key' 
    });
  }
} 