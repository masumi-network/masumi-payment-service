import { z } from 'zod';

/**
 * Schema-only module for swap API. Kept separate so OpenAPI/swagger generator
 * can import it without loading @sundaeswap runtime (which has ESM/dependency issues in tsx).
 */
export const swapTokensSchemaInput = z.object({
	walletVkey: z.string().min(1).describe('Wallet verification key (vKey) to identify the wallet'),
	amount: z.number().positive().describe('Amount to swap (in ADA or token units)'),
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
