import { BlockfrostProvider, MeshTxBuilder, Network, UTxO } from '@meshsdk/core';
import { BlockFrostAPI } from '@blockfrost/blockfrost-js';

/** Minimum lovelace in a single UTXO to attempt a split (2×2 ADA outputs + fee buffer) */
export const MIN_LOVELACE_FOR_SPLIT = 4_500_000;

/** Poll interval and max wait for split tx confirmation */
const SPLIT_TX_POLL_MS = 3000;
const SPLIT_TX_MAX_WAIT_MS = 120_000;

export function getLovelaceFromUtxo(utxo: UTxO): number {
	return parseInt(utxo.output.amount.find((a) => a.unit === 'lovelace' || a.unit === '')?.quantity ?? '0');
}

export async function waitForTxConfirmation(txHash: string, blockfrost: BlockFrostAPI): Promise<void> {
	const deadline = Date.now() + SPLIT_TX_MAX_WAIT_MS;
	while (Date.now() < deadline) {
		const tx = await blockfrost.txs(txHash);
		if (tx.block != null) {
			return;
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
