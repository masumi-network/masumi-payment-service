/* eslint-disable @typescript-eslint/no-explicit-any */

import axios from 'axios';
import { Token } from '@/types/token';

interface SwapParams {
  mnemonic: string;
  amount: number;
  isFromAda: boolean;
  fromToken: Token;
  toToken: Token;
  poolId: string;
}

export const executeSwap = async (params: SwapParams) => {
  const baseUrl = "https://ada-swap-production.up.railway.app";
  try {
    const response = await axios.post(
      `${baseUrl}/api/swap`,
      {
        mnemonic: params.mnemonic,
        amount: params.amount,
        isFromAda: params.isFromAda,
        fromToken: params.fromToken,
        toToken: params.toToken,
        poolId: params.fromToken.poolId || params.toToken.poolId,
      },
    );

    if (!response.data.success) {
      throw new Error(response.data.error || 'Swap failed');
    }

    return {
      success: true,
      txHash: response?.data?.data?.txHash || '',
    };
  } catch (error: any) {
    throw new Error(error?.response?.data?.error || 'Swap failed');
  }
};
