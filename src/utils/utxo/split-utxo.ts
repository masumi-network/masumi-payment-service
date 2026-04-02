import { BlockfrostProvider, MeshTxBuilder, Network, UTxO } from '@meshsdk/core';
import { BlockFrostAPI } from '@blockfrost/blockfrost-js';

/**
 * Minimum lovelace in a single UTXO to attempt a split.
 * Needs to cover: collateral output (5 ADA) + fee buffer (~0.5 ADA) = 5_500_000
 */
export const MIN_LOVELACE_FOR_SPLIT = 5_500_000;
export const MIN_CHANGE_LOVELACE = 1_500_000;

/** Poll interval and max wait for split tx confirmation */
const SPLIT_TX_POLL_MS = 3000;
const SPLIT_TX_MAX_WAIT_MS = 120_000;

/** Maximum polling iterations to prevent infinite loops */
const SPLIT_TX_MAX_POLL_ITERATIONS = Math.ceil(SPLIT_TX_MAX_WAIT_MS / SPLIT_TX_POLL_MS);

export function getLovelaceFromUtxo(utxo: UTxO): number {
	return parseInt(utxo.output.amount.find((a) => a.unit === 'lovelace' || a.unit === '')?.quantity ?? '0');
}

export async function waitForTxConfirmation(txHash: string, blockfrost: BlockFrostAPI): Promise<void> {
	const deadline = Date.now() + SPLIT_TX_MAX_WAIT_MS;
	let iterations = 0;
	while (Date.now() < deadline && iterations < SPLIT_TX_MAX_POLL_ITERATIONS) {
		iterations++;
		try {
			const tx = await blockfrost.txs(txHash);
			if (tx.block != null) {
				return;
			}
		} catch (err: unknown) {
			// BlockFrost returns 404 while the tx is in the mempool (not yet on-chain).
			// Treat 404 as "not confirmed yet" and keep polling.
			const status = (err as { status_code?: number })?.status_code;
			if (status === 404) {
				// tx not yet on-chain — keep polling
			} else {
				throw err;
			}
		}
		await new Promise((resolve) => setTimeout(resolve, SPLIT_TX_POLL_MS));
	}
	throw new Error(`Split transaction ${txHash} did not confirm within ${SPLIT_TX_MAX_WAIT_MS / 1000}s`);
}

export interface ExecuteSplitParams {
	wallet: {
		signTx: (tx: string, partial?: boolean) => Promise<string>;
		submitTx: (signedTx: string) => Promise<string>;
	};
	blockchainProvider: BlockfrostProvider;
	address: string;
	network: Network;
	singleUtxo: UTxO;
	blockfrost: BlockFrostAPI;
	splitOutputLovelace: number;
}

/**
 * Splits a single UTXO into 2 outputs (splitOutputLovelace + change).
 * Signs, submits, waits for confirmation.
 */
export async function executeSingleUtxoSplit(params: ExecuteSplitParams): Promise<void> {
	const { wallet, blockchainProvider, address, network, singleUtxo, blockfrost, splitOutputLovelace } = params;
	const txBuilder = new MeshTxBuilder({ fetcher: blockchainProvider });
	const unsignedSplit = await txBuilder
		.txIn(singleUtxo.input.txHash, singleUtxo.input.outputIndex)
		.txOut(address, [{ unit: 'lovelace', quantity: splitOutputLovelace.toString() }])
		.changeAddress(address)
		.setNetwork(network)
		.complete();
	const signedSplit = await wallet.signTx(unsignedSplit, true);
	const txHash = await wallet.submitTx(signedSplit);
	await waitForTxConfirmation(txHash, blockfrost);
}
