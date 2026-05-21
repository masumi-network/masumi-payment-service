import { BlockFrostAPI } from '@blockfrost/blockfrost-js';
import { BlockfrostProvider } from '@meshsdk/core';
import { Network } from '@/generated/prisma/client';
import { getBlockfrostInstance } from '@/utils/blockfrost';
import { getCachedBlockfrostProvider } from '@/utils/mesh-cost-model-sync';

type ProviderFactory = {
	createApiClient: (network: Network, apiKey: string) => BlockFrostAPI;
	createMeshProvider: (apiKey: string) => BlockfrostProvider;
};

const providerFactory: ProviderFactory = {
	createApiClient(network: Network, apiKey: string) {
		return getBlockfrostInstance(network, apiKey);
	},
	// Singleton per API key. Each `new BlockfrostProvider(apiKey)` carries its
	// own HTTP client + protocol-params cache; spawning one per service made
	// chain-params/cost-models drift across instances and burned extra
	// connections. The cache lives in mesh-cost-model-sync so the cost-model
	// sync helper and the tx-builder paths see the SAME provider.
	createMeshProvider(apiKey: string) {
		return getCachedBlockfrostProvider(apiKey);
	},
};

export function createApiClient(network: Network, apiKey: string) {
	return providerFactory.createApiClient(network, apiKey);
}

export function createMeshProvider(apiKey: string) {
	return providerFactory.createMeshProvider(apiKey);
}
