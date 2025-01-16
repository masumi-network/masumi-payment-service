// USE MESHJS BLOCKFROST PROVIDER DIRECTLY INSTEAD!!!
// FROM LEVVYWIFHAT SACRIFICE
// useEffect(() => {
//   const getBalance = async () => {
//       if (wallet && connected) {
//           try {
//               setFetchingWalletBalance(true)
//               const balance = await wallet?.getBalance()
//               const lovelaceAmount = balance?.find(asset => asset.unit === "lovelace")?.quantity || 0;
//               const adaAmount = (parseInt(lovelaceAmount) / 1000000).toFixed(2);
//               setWalletBalance(`${adaAmount}`);
//               localStorage?.setItem("last-balance", adaAmount)
//               const tokenAsset = balance?.find(asset => asset.unit?.startsWith(tokenPolicyId));
//               const tokenAmount = tokenAsset?.quantity || 0;
//               setTokenBalance(tokenAmount.toString());
//               setFetchingWalletBalance(false)
//           } catch (error) {
//               console.error("Error fetching wallet balance:", error);
//               setWalletBalance("");
//               setTokenBalance("");
//               setFetchingWalletBalance(false)
//           }
//       }
//   };
//   getBalance();
// }, [wallet, connected, tokenPolicyId]);

import type { NextApiRequest, NextApiResponse } from 'next';

type BalanceResponse = {
  ada: number;
  usdm: number;
} | {
  error: string;
}

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse<BalanceResponse>
) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { address, apiKey } = req.query;

  if (!address || !apiKey) {
    return res.status(400).json({ error: 'Missing required parameters' });
  }

  try {
    const balanceResponse = await fetch(
      `https://cardano-mainnet.blockfrost.io/api/v0/addresses/${address}`,
      {
        headers: {
          'project_id': apiKey as string,
        },
      }
    );

    if (!balanceResponse.ok) {
      throw new Error('Failed to fetch ADA balance');
    }

    const balanceData = await balanceResponse.json();
    
    // Convert lovelace to ADA (1 ADA = 1,000,000 lovelace)
    const adaBalance = parseInt(balanceData.amount[0].quantity) / 1000000;

    // Fetch asset balances to find USDM
    const assetsResponse = await fetch(
      `https://cardano-mainnet.blockfrost.io/api/v0/addresses/${address}/assets`,
      {
        headers: {
          'project_id': apiKey as string,
        },
      }
    );

    if (!assetsResponse.ok) {
      throw new Error('Failed to fetch assets');
    }

    const assetsData = await assetsResponse.json();
    
    const usdmAsset = assetsData.find((asset: any) => 
      asset.unit === 'YOUR_USDM_ASSET_ID'
    );

    const usdmBalance = usdmAsset ? parseInt(usdmAsset.quantity) : 0;

    return res.status(200).json({
      ada: adaBalance,
      usdm: usdmBalance
    });

  } catch (error) {
    console.error('Error fetching wallet balance:', error);
    return res.status(500).json({ error: 'Failed to fetch wallet balance' });
  }
} 