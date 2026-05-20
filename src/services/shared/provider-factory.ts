import { BlockFrostAPI } from '@blockfrost/blockfrost-js';
import { BlockfrostProvider } from '@meshsdk/core';
import { Network } from '@/generated/prisma/client';
import { getBlockfrostInstance } from '@/utils/blockfrost';
import { syncMeshCostModelsFromChain } from '@/utils/mesh-cost-model-sync';

type ProviderFactory = {
	createApiClient: (network: Network, apiKey: string) => BlockFrostAPI;
	createMeshProvider: (apiKey: string) => BlockfrostProvider;
};

const providerFactory: ProviderFactory = {
	createApiClient(network: Network, apiKey: string) {
		return getBlockfrostInstance(network, apiKey);
	},
	createMeshProvider(apiKey: string) {
		return new BlockfrostProvider(apiKey);
	},
};

export function createApiClient(network: Network, apiKey: string) {
	return providerFactory.createApiClient(network, apiKey);
}

/**
 * Construct a mesh-sdk BlockfrostProvider AND refresh mesh-sdk's bundled
 * Plutus cost models from the chain in one step. The cost-model sync is
 * required because mesh-sdk's hashScriptData() uses static, bundled
 * `DEFAULT_V*_COST_MODEL_LIST` arrays that go stale after Cardano protocol
 * parameter updates, causing the ledger to reject submissions with
 * `PPViewHashesDontMatch`. The sync mutates those arrays in place from
 * Blockfrost's `cost_models_raw`. Memoized per-process; safe to await before
 * every tx build. See `src/utils/mesh-cost-model-sync` for the details.
 */
export async function createMeshProvider(apiKey: string): Promise<BlockfrostProvider> {
	await syncMeshCostModelsFromChain(apiKey);
	return providerFactory.createMeshProvider(apiKey);
}
