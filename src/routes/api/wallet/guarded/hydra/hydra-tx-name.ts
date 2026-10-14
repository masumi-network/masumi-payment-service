import type { Network } from '@/generated/prisma/client';
import { getBlockfrostInstance } from '@/utils/blockfrost';

/** hydra-node names every L1 tx it posts under this metadata label, e.g. `HydraV2/DecrementTx`. */
const HYDRA_TX_NAME_LABEL = '55555';
const FANOUT_TX_NAMES = new Set(['HydraV2/FanoutTx', 'HydraV2/PartialFanoutTx', 'HydraV2/FinalPartialFanoutTx']);

/**
 * True when a head fanout created this L1 tx's outputs. A wallet output from a
 * fanout left the head because the head closed, not through a withdraw. Throws
 * when the lookup fails, so the caller can leave the move unsettled.
 */
export async function isHydraFanoutTx(network: Network, rpcApiKey: string, txHash: string): Promise<boolean> {
	const metadata = await getBlockfrostInstance(network, rpcApiKey).txsMetadata(txHash);
	return metadata.some(
		(entry) =>
			entry.label === HYDRA_TX_NAME_LABEL &&
			typeof entry.json_metadata === 'string' &&
			FANOUT_TX_NAMES.has(entry.json_metadata),
	);
}
