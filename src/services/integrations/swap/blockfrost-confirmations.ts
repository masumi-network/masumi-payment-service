import type { BlockFrostAPI } from '@blockfrost/blockfrost-js';

export type SwapTxInclusion =
	| { kind: 'not_found' }
	| { kind: 'unconfirmed' }
	| { kind: 'included'; confirmations: number };

/**
 * Whether a swap-related tx is visible on-chain and how deep it is (Blockfrost block confirmations).
 */
export async function getSwapTxInclusion(blockfrost: BlockFrostAPI, txHash: string): Promise<SwapTxInclusion> {
	try {
		const tx = await blockfrost.txs(txHash);
		if (!tx.block) {
			return { kind: 'unconfirmed' };
		}
		const block = await blockfrost.blocks(tx.block);
		return { kind: 'included', confirmations: block.confirmations ?? 0 };
	} catch (error: unknown) {
		const msg = error instanceof Error ? error.message : String(error);
		if (msg.includes('404') || msg.toLowerCase().includes('not found')) {
			return { kind: 'not_found' };
		}
		throw error;
	}
}
