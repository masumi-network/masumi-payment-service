import createHttpError from 'http-errors';
import type { BlockFrostAPI } from '@blockfrost/blockfrost-js';
import { getChainErrorStatus } from '@/services/shared/chain-tx-lookup';

// Blockfrost pages UTxOs 100 at a time, and the Mesh fetch in the builders walks every page.
export const X402_BUYER_UTXO_PAGE_SIZE = 100;
export const X402_MAX_BUYER_UTXO_PAGES = 10;

// One probe past the last allowed page bounds the builders' unbounded walk for a caller-chosen address.
export async function assertBuyerUtxoCountWithinLimit(blockfrost: BlockFrostAPI, buyerAddress: string): Promise<void> {
	let overflowPage: unknown[];
	try {
		overflowPage = await blockfrost.addressesUtxos(buyerAddress, {
			page: X402_MAX_BUYER_UTXO_PAGES + 1,
			count: X402_BUYER_UTXO_PAGE_SIZE,
		});
	} catch (error) {
		// Blockfrost answers 404 for an address with no history; the builder rejects it as having no UTXOs.
		if (getChainErrorStatus(error) === 404) return;
		throw error;
	}
	if (overflowPage.length > 0) {
		throw createHttpError(
			400,
			`buyerAddress holds more than ${X402_MAX_BUYER_UTXO_PAGES * X402_BUYER_UTXO_PAGE_SIZE} UTxOs; consolidate the wallet and retry`,
		);
	}
}
