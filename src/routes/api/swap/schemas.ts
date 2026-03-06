import { z } from 'zod';

/**
 * Schema-only module for swap API. Kept separate so OpenAPI/swagger generator
 * can import it without loading @sundaeswap runtime (which has ESM/dependency issues in tsx).
 */
export const swapTokensSchemaInput = z.object({
	walletVkey: z.string().min(1).describe('Wallet verification key (vKey) to identify the wallet'),
	amount: z
		.number()
		.positive()
		.max(1e12)
		.describe('Amount to swap (in ADA or token units). Capped to prevent overflow/DoS.'),
	fromToken: z
		.object({
			policyId: z.string().describe('Policy ID of the source token. Use empty string "" for ADA (native token)'),
			assetName: z.string().describe('Asset name of the source token. Use empty string "" for ADA'),
			name: z.string().describe('Name of the source token'),
		})
		.describe('Source token information'),
	toToken: z
		.object({
			policyId: z.string().describe('Policy ID of the destination token. Use empty string "" for ADA (native token)'),
			assetName: z.string().describe('Asset name of the destination token. Use empty string "" for ADA'),
			name: z.string().describe('Name of the destination token'),
		})
		.describe('Destination token information'),
	poolId: z.string().describe('SundaeSwap pool identifier'),
	slippage: z.number().min(0).max(1).optional().describe('Slippage tolerance (0-1, default: 0.03 for 3%)'),
});

export const swapTokensSchemaOutput = z.object({
	txHash: z.string().describe('Transaction hash of the swap'),
	walletAddress: z.string().describe('Wallet address used for the swap'),
});

export const getSwapConfirmSchemaInput = z.object({
	txHash: z.string().min(1).describe('Transaction hash to check'),
	walletVkey: z.string().min(1).describe('Wallet verification key (vKey) that submitted the swap'),
});

export const cancelSwapSchemaInput = z.object({
	walletVkey: z.string().min(1).describe('Wallet verification key (vKey) of the wallet that placed the order'),
	swapTransactionId: z.string().min(1).describe('ID of the SwapTransaction to cancel'),
});

export const cancelSwapSchemaOutput = z.object({
	cancelTxHash: z.string().describe('Transaction hash of the cancel transaction'),
});

export const acknowledgeSwapTimeoutSchemaInput = z.object({
	walletVkey: z.string().min(1).describe('Wallet verification key (vKey) of the wallet'),
	swapTransactionId: z.string().min(1).describe('ID of the timed-out SwapTransaction'),
});

export const acknowledgeSwapTimeoutSchemaOutput = z.object({
	swapStatus: z.string().describe('New swap status after acknowledgement'),
	message: z.string().describe('Human-readable explanation of what happened'),
});

export const getSwapTransactionsSchemaInput = z.object({
	walletVkey: z.string().min(1).describe('Wallet verification key (vKey) to filter swap transactions'),
	limit: z.coerce.number().min(1).max(100).default(10).describe('Number of swap transactions to return'),
	cursorId: z.string().optional().describe('Cursor ID for pagination'),
});

export const swapTransactionSchema = z.object({
	id: z.string().describe('Swap transaction ID'),
	createdAt: z.string().describe('Creation timestamp'),
	txHash: z.string().nullable().describe('On-chain transaction hash'),
	status: z.string().describe('Transaction status'),
	swapStatus: z
		.string()
		.describe('Swap lifecycle status (OrderPending, OrderConfirmed, CancelPending, CancelConfirmed, Completed)'),
	confirmations: z.number().nullable().optional().describe('Number of block confirmations'),
	fromPolicyId: z.string().describe('Source token policy ID'),
	fromAssetName: z.string().describe('Source token asset name'),
	fromAmount: z.string().describe('Amount swapped'),
	toPolicyId: z.string().describe('Destination token policy ID'),
	toAssetName: z.string().describe('Destination token asset name'),
	poolId: z.string().describe('SundaeSwap pool ID'),
	slippage: z.number().nullable().optional().describe('Slippage tolerance used'),
	cancelTxHash: z.string().nullable().optional().describe('Transaction hash of cancel transaction'),
	orderOutputIndex: z.number().nullable().optional().describe('Output index of the order UTXO'),
});

export const getSwapTransactionsSchemaOutput = z.object({
	swapTransactions: z.array(swapTransactionSchema).describe('List of swap transactions'),
});

export const getSwapEstimateSchemaInput = z.object({
	fromPolicyId: z.string().describe('Policy ID of the source token. Use empty string "" for ADA'),
	fromAssetName: z.string().describe('Asset name (hex) of the source token. Use empty string "" for ADA'),
	toPolicyId: z.string().describe('Policy ID of the destination token. Use empty string "" for ADA'),
	toAssetName: z.string().describe('Asset name (hex) of the destination token. Use empty string "" for ADA'),
	poolId: z.string().min(1).describe('SundaeSwap pool identifier'),
});

export const getSwapEstimateSchemaOutput = z.object({
	rate: z.number().describe('Estimated conversion rate (toToken per 1 fromToken, after pool fee)'),
	fee: z.number().describe('Pool fee as a decimal (e.g. 0.003 for 0.3%)'),
	fromDecimals: z.number().describe('Decimal places of the source token'),
	toDecimals: z.number().describe('Decimal places of the destination token'),
});

export const getSwapConfirmSchemaOutput = z.object({
	status: z
		.enum(['pending', 'confirmed', 'not_found'])
		.describe('On-chain status: pending (not yet in a block), confirmed (in a block), not_found (tx unknown)'),
	swapStatus: z
		.string()
		.optional()
		.describe('Swap lifecycle status (OrderPending, OrderConfirmed, CancelPending, CancelConfirmed, Completed)'),
	swapTransactionId: z.string().optional().describe('SwapTransaction ID, returned when lifecycle transition occurs'),
	confirmations: z
		.number()
		.int()
		.nonnegative()
		.nullable()
		.optional()
		.describe('Number of block confirmations. Present when status is confirmed.'),
});
