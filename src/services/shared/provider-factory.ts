import { BlockFrostAPI } from '@blockfrost/blockfrost-js';
import { BlockfrostProvider } from '@meshsdk/core';
import { Network } from '@/generated/prisma/client';
import { getBlockfrostInstance } from '@/utils/blockfrost';

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

export function createMeshProvider(apiKey: string) {
	return providerFactory.createMeshProvider(apiKey);
}
