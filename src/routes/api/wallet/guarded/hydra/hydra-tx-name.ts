import type { Network } from '@/generated/prisma/client';
import { getBlockfrostInstance } from '@/utils/blockfrost';

/** hydra-node names every L1 tx it posts under this metadata label, e.g. `HydraV2/DecrementTx`. */
const HYDRA_TX_NAME_LABEL = '55555';
const DECREMENT_TX_NAME = 'HydraV2/DecrementTx';
const FANOUT_TX_NAMES = new Set(['HydraV2/FanoutTx', 'HydraV2/PartialFanoutTx', 'HydraV2/FinalPartialFanoutTx']);
/** Each step costs two Blockfrost calls. A wallet that spent more often than this since it left the head is `unknown`. */
const MAX_WALK_STEPS = 20;

/** `none`: the newest hydra-node tx is no exit (a deposit or recover), or the mint comes first. */
export type WalletHydraExit = 'decrement' | 'fanout' | 'none' | 'unknown';

/**
 * How the wallet last left a head. Walks back from the tx that created its L1
 * UTxO, through the wallet's own L1 spends (agent purchases, owner updates), to
 * the newest tx that hydra-node posted. Throws when a lookup fails.
 */
export async function findWalletHydraExit(params: {
	network: Network;
	rpcApiKey: string;
	utxoTxHash: string;
	stateTokenUnit: string;
}): Promise<WalletHydraExit> {
	const blockfrost = getBlockfrostInstance(params.network, params.rpcApiKey);
	let txHash = params.utxoTxHash;
	for (let step = 0; step < MAX_WALK_STEPS; step++) {
		const metadata = await blockfrost.txsMetadata(txHash);
		const name = metadata.find((entry) => entry.label === HYDRA_TX_NAME_LABEL)?.json_metadata;
		if (name === DECREMENT_TX_NAME) return 'decrement';
		if (typeof name === 'string' && FANOUT_TX_NAMES.has(name)) return 'fanout';
		if (name != null) return 'none';
		const { inputs } = await blockfrost.txsUtxos(txHash);
		const walletInput = inputs.find(
			(input) =>
				!input.collateral && !input.reference && input.amount.some((asset) => asset.unit === params.stateTokenUnit),
		);
		// No wallet input: the state token was minted here, so the wallet never left a head.
		if (walletInput == null) return 'none';
		txHash = walletInput.tx_hash;
	}
	return 'unknown';
}
