import {
  getSwapConfirm,
  getSwapTransactions,
  postSwap,
  postSwapAcknowledgeTimeout,
  postSwapCancel,
} from '@/lib/api/generated';
import { extractApiPayload } from '@/lib/api-response';

export type SwapConfirmPayload = {
  status?: string;
  swapStatus?: string;
  swapTransactionId?: string | null;
  message?: string;
};

export type SwapMutationPayload = {
  txHash?: string | null;
  cancelTxHash?: string | null;
  swapStatus?: string;
  swapTransactionId?: string | null;
  message?: string;
};

export type SwapTransactionPayload = {
  id: string;
  createdAt: string;
  txHash: string | null;
  status: string;
  swapStatus?: string;
  confirmations?: number | null;
  fromPolicyId: string;
  fromAssetName: string;
  fromAmount: string;
  toPolicyId: string;
  toAssetName: string;
  poolId: string;
  slippage?: number | null;
  cancelTxHash?: string | null;
  orderOutputIndex?: number | null;
};

export type SwapTransactionsPayload = {
  SwapTransactions?: SwapTransactionPayload[];
};

export function extractSwapConfirmPayload(
  response: Awaited<ReturnType<typeof getSwapConfirm>>,
): SwapConfirmPayload {
  return extractApiPayload<SwapConfirmPayload>(response) ?? {};
}

export function extractSwapSubmitPayload(
  response: Awaited<ReturnType<typeof postSwap>>,
): SwapMutationPayload {
  return extractApiPayload<SwapMutationPayload>(response) ?? {};
}

export function extractSwapCancelPayload(
  response: Awaited<ReturnType<typeof postSwapCancel>>,
): SwapMutationPayload {
  return extractApiPayload<SwapMutationPayload>(response) ?? {};
}

export function extractSwapAcknowledgePayload(
  response: Awaited<ReturnType<typeof postSwapAcknowledgeTimeout>>,
): SwapMutationPayload {
  return extractApiPayload<SwapMutationPayload>(response) ?? {};
}

export function extractSwapTransactionsPayload(
  response: Awaited<ReturnType<typeof getSwapTransactions>>,
) {
  return extractApiPayload<SwapTransactionsPayload>(response)?.SwapTransactions ?? [];
}
