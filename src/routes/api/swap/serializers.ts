import type { SwapTransactionRecord } from './queries';

export function serializeSwapTransaction(tx: SwapTransactionRecord) {
	return {
		id: tx.id,
		createdAt: tx.createdAt.toISOString(),
		txHash: tx.txHash,
		status: tx.status,
		swapStatus: tx.swapStatus,
		confirmations: tx.confirmations,
		fromPolicyId: tx.fromPolicyId,
		fromAssetName: tx.fromAssetName,
		fromAmount: tx.fromAmount,
		toPolicyId: tx.toPolicyId,
		toAssetName: tx.toAssetName,
		poolId: tx.poolId,
		slippage: tx.slippage,
		cancelTxHash: tx.cancelTxHash,
		orderOutputIndex: tx.orderOutputIndex,
	};
}

export function serializeSwapTransactionsResponse(swapTransactions: SwapTransactionRecord[]) {
	return {
		SwapTransactions: swapTransactions.map(serializeSwapTransaction),
	};
}
